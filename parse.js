// parse.js — a fast, dependency-free Markdown renderer.
// Round 2 resubmit — rewritten under recording R4 (2026-11-16).
//
// Renders exactly what marked 18.1.3 renders with its default options
// (GFM on, hard breaks off, pedantic off): for every input string the HTML
// this module returns is byte-identical to marked.parse(input).
//
// How it works, in one paragraph: the input is first normalised (\r\n and
// \r become \n), then a block pass cuts it into blocks (headings, fences,
// lists, blockquotes, tables, paragraphs ...), collecting link reference
// definitions as it goes. Inline parsing runs afterwards, per block, so a
// reference defined anywhere in the document resolves everywhere. Inline
// parsing walks each block's text left to right, trying the token kinds in
// marked's order (escape, tag, link, reference link, emphasis, code span,
// hard break, strikethrough, autolink, extended autolink, plain text) and
// renders the resulting token tree straight to HTML.
//
// Speed comes from three places: every grammar pattern is compiled once at
// module load; the block and inline loops dispatch on the first character
// so most token kinds are never even attempted; and the inline pass takes
// a fast path for runs of plain text with no markup at all.
//
// Only the GFM rule set is implemented: the defaults this module targets
// never enable pedantic mode or hard-break mode, so those variants are
// deliberately absent.

'use strict';

// ---------------------------------------------------------------------------
// Regex composition
//
// Several of the grammar patterns are built by plugging smaller patterns
// into a template (a heading pattern inside a paragraph's stop list, the
// table pattern inside a paragraph's stop list, ...). This builder does
// that: `rx(template)` starts from a source string or RegExp, `.sub(name,
// pattern)` replaces the first (string name) or every (global RegExp name)
// occurrence, and `.re()` compiles the result. A pattern plugged into the
// middle of a bigger expression loses its leading ^ anchor — an anchor in
// the middle would pin the match to the start of the whole string, which
// is never what the grammar means. The anchor is dropped only when it sits
// at the very start of the plugged-in source or right after a character
// that is not '[' (so a ^ inside a character class, like [^\n], survives).
// ---------------------------------------------------------------------------

const CARET_STRIP = /(^|[^\[])\^/g;

function rx(template, flags) {
  let src = typeof template === 'string' ? template : template.source;
  const api = {
    sub(name, pattern) {
      let rep = typeof pattern === 'string' ? pattern : pattern.source;
      rep = rep.replace(CARET_STRIP, '$1');
      src = typeof name === 'string' ? src.replace(name, () => rep) : src.replace(name, () => rep);
      return api;
    },
    re() {
      return new RegExp(src, flags || '');
    },
  };
  return api;
}

// A factory for patterns that depend on an indent level (0..3). The level
// is clamped to that range and the compiled pattern is cached per level,
// because the same levels recur constantly inside nested lists.
function indentMemo(build) {
  const cache = [];
  return (level) => {
    const n = Math.max(0, Math.min(3, level - 1));
    let re = cache[n];
    if (!re) {
      re = build(n);
      cache[n] = re;
    }
    return re;
  };
}

// ---------------------------------------------------------------------------
// Shared small patterns (the "other" set)
// ---------------------------------------------------------------------------

const RE = {
  // indented code: strip up to one level of indent from every line
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  // in a link label, a backslash before [ or ] is just the bracket
  outputLinkReplace: /\\([\[\]])/g,
  // a fenced code block's closing fence may be indented; the indent of the
  // opening fence's first line tells how much to strip from the content
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  // numeric character references, and a bare & that does not start one
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,

  // list-item patterns, parameterised by the bullet marker / indent level
  listItemRegex: (marker) => new RegExp(`^( {0,3}${marker})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: indentMemo((n) =>
    new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`)),
  hrRegex: indentMemo((n) =>
    new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`)),
  fencesBeginRegex: indentMemo((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: indentMemo((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: indentMemo((n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      'i',
    )),
  blockquoteBeginRegex: indentMemo((n) => new RegExp(`^ {0,${n}}>`)),
};

// The block-level HTML tag names (CommonMark's block tag list).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HR_NC = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK_CODE_INDENT = /(?: {4}| {0,3}\t)/;
// what an HTML block may start with, inside a paragraph's stop list
const HTML_OPEN =
  ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const FENCES_OPEN = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HEADING_OPEN = ' {0,3}#{1,6}(?:\\s|$)';

// A paragraph is a run of lines that does not start a new block. `listPat`
// is the list-marker pattern the paragraph must stop at; blockquotes use a
// looser one than top-level paragraphs.
function paragraphRegex(listPat) {
  return rx(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .sub('hr', HR)
    .sub('heading', HEADING_OPEN)
    .sub('|lheading', '')
    .sub('|table', '')
    .sub('blockquote', ' {0,3}>')
    .sub('fences', FENCES_OPEN)
    .sub('list', listPat)
    .sub('html', HTML_OPEN)
    .sub('tag', BLOCK_TAGS)
    .re();
}

// A setext heading: text lines, then a line of = or - underlines.
const LHEADING = rx(
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/,
)
  .sub(/bull/g, BULLET)
  .sub(/blockCode/g, BLOCK_CODE_INDENT)
  .sub(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
  .sub(/blockquote/g, ' {0,3}>')
  .sub(/heading/g, HEADING_OPEN)
  .sub(/hr/g, HR_NC)
  .sub(/html/g, ' {0,3}<[^\\n>]+>\\n')
  .sub(/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n')
  .re();

// A table: header line, delimiter line, then body rows that are not
// themselves the start of another block.
const TABLE = rx(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .sub('hr', HR)
  .sub('heading', HEADING_OPEN)
  .sub('blockquote', ' {0,3}>')
  .sub('code', "(?: {4}| {0,3}	)[^\\n]")
  .sub('fences', FENCES_OPEN)
  .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .sub('html', HTML_OPEN)
  .sub('tag', BLOCK_TAGS)
  .re();

// A link reference definition: [label]: <href> "title"
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF = rx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .sub('label', LABEL)
  .sub('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .re();

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: HR,
  lheading: LHEADING,
  table: TABLE,
  def: DEF,
  // a list starts with a bullet or an ordered marker; group 1 is the
  // marker (with its leading spaces), group 2 the rest of the first line
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  // a blockquote: > lines, whose first line may itself be a paragraph
  blockquote: rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub(
    'paragraph',
    paragraphRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'),
  ).re(),
  // an HTML block, type 1-6 in the CommonMark sense
  html: rx(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
    'i',
  )
    .sub('comment', /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
    .sub('tag', BLOCK_TAGS)
    .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .re(),
  // top-level paragraph (GFM): a table delimiter line also stops it
  paragraph: rx(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
    .sub('hr', HR)
    .sub('heading', HEADING_OPEN)
    .sub('|lheading', '')
    .sub('table', TABLE)
    .sub('blockquote', ' {0,3}>')
    .sub('fences', FENCES_OPEN)
    .sub('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .sub('html', HTML_OPEN)
    .sub('tag', BLOCK_TAGS)
    .re(),
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

// character classes used by the emphasis / strikethrough machinery
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u; // punctuation, symbol or whitespace
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // anything but those
// the GFM variants treat ~ as a word character for delimiter purposes
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

// the content of a link label: nested brackets, escapes, code spans
const LABEL_CONTENT = rx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .sub('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
  .re();
// same, but bounded, for the reference-link search used while masking
const LABEL_CONTENT_BOUNDED = rx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
)
  .sub('brackets', /\[(?:\\[\s\S]|[^\[\]\\])*\]/)
  .re();
const REF_NAME = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // plain text: runs up to the next thing that could start a token
  text: rx(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  )
    .sub('protocol', PROTOCOL)
    .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
    .sub('wwwStart', /(?<![^\s*_~(])www\./)
    .re(),
  // can the character before a delimiter open emphasis?
  punctuation: rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).re(),
  // an emphasis opener: a run of * or _ plus the character after it
  emStrongLDelim: rx(
    /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
    'u',
  )
    .sub(/punct/g, PUNCT_GFM)
    .re(),
  // an emphasis closer for *: the right-delimiter search, GFM flavour
  emStrongRDelimAst: rx(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_GFM)
    .sub(/punctSpace/g, PUNCT_SPACE_GFM)
    .sub(/punct/g, PUNCT_GFM)
    .re(),
  // an emphasis closer for _
  emStrongRDelimUnd: rx(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .re(),
  // a strikethrough opener: ~~ or ~ plus the character after it
  delLDelim: rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).re(),
  // a strikethrough closer
  delRDelim: rx(
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .re(),
  // a backslash-escaped punctuation character
  anyPunctuation: rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).re(),
  // ... outside code spans, for masking emphasis delimiters
  anyPunctuationOutsideCode: rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
    .sub(/punct/g, PUNCT)
    .re(),
  autolink: rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/
  )
    .sub('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .sub('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
    .re(),
  // an HTML comment, for the inline tag pattern
  tag: rx(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  )
    .sub('comment', /<!--(?:-?>|[\s\S]*?-->)/)
    .sub(
      'attribute',
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    )
    .re(),
  // [text](href "title")
  link: rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .sub('label', LABEL_CONTENT)
    .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .re(),
  // [text][ref]
  reflink: rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_CONTENT).sub('ref', LABEL).re(),
  // [ref] or [ref][]
  nolink: rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LABEL).re(),
  // finds candidate reference links while masking, so their brackets do
  // not look like emphasis delimiters
  reflinkSearch: rx('reflink|nolink(?!\\()', 'g')
    .sub(
      'reflink',
      rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LABEL_CONTENT_BOUNDED).sub('ref', REF_NAME).re(),
    )
    .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', REF_NAME).re())
    .re(),
  // finds links, code spans and raw HTML while masking
  blockSkip: rx(/link|precode-code|html/, 'g')
    .sub(
      'link',
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    )
    .sub('precode-', /(?<!`)()/)
    .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .sub('html', /<(?! )[^<>]*?>/)
    .re(),
  // extended autolinks: www., http(s)://, ftp://, bare e-mails
  url: rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .sub(
      'emailProtocol',
      rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_LOCAL).re(),
    )
    .sub('protocol', PROTOCOL)
    .sub('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .re(),
  // trims trailing punctuation off an extended autolink
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// ---------------------------------------------------------------------------
// Per-parse context
//
// marked builds a fresh Lexer/Tokenizer/Parser per parse() call; this module
// does the same with one plain object, held in CTX while a parse runs.
// parse() is synchronous and non-reentrant, so a module-level slot is safe.
// ---------------------------------------------------------------------------

let CTX = null;

function newCtx() {
  return {
    links: Object.create(null),
    hasLinks: false,
    inlineQueue: [],
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
    hintStack: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers (marked src/helpers.ts, defaults-only: no pedantic, no hooks)
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(html, encode) {
  if (encode) {
    if (RE.escapeTest.test(html)) return html.replace(RE.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  } else if (RE.escapeTestNoEncode.test(html)) {
    return html.replace(RE.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
  }
  return html;
}

function decodeNumericCharacterReferences(text) {
  if (!RE.numericCharacterReference.test(text)) return text;
  return text.replace(RE.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(RE.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(RE.findPipe, (match, offset, str) => {
      let escaped = false;
      let curr = offset;
      while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
      return escaped ? '|' : ' |';
    }),
    cells = row.split(RE.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(RE.slashPipe, '|');
  return cells;
}

// Remove trailing 'c's (or, with invert, trailing non-'c's).
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && RE.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(RE.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// --- closer hints for emStrong / del (one scan per inline pass) -----------

function scanClosers(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}

function beginCloserScan(maskedSrc) {
  CTX.hintStack.push(scanClosers(maskedSrc));
}

function endCloserScan() {
  CTX.hintStack.pop();
}

function cachedLastEmStrongCloserIndex(maskedSrc, delim) {
  const frame = CTX.hintStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanClosers(maskedSrc).lastEm[delim];
}

function cachedLastDelCloserIndex(maskedSrc) {
  const frame = CTX.hintStack.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanClosers(maskedSrc).lastDel;
}

// ---------------------------------------------------------------------------
// Block tokenizers (marked src/Tokenizer.ts, block half)
// ---------------------------------------------------------------------------

function outputLink(cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(RE.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';

  const outerInLink = CTX.state.inLink;
  const outerLinkEmitted = CTX.state.linkEmitted;
  const outerInRawBlock = CTX.state.inRawBlock;
  CTX.state.inLink = true;
  CTX.state.linkEmitted = false;
  const tokens = inlineTokens(text);
  const textHasLink = CTX.state.linkEmitted;
  CTX.state.linkEmitted = outerLinkEmitted;
  CTX.state.inLink = outerInLink;

  if (!isImage) {
    // Links may not contain other links, at any level of nesting.
    if (textHasLink) {
      CTX.state.inRawBlock = outerInRawBlock;
      return;
    }
    CTX.state.linkEmitted = true;
  }

  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(RE.indentCodeCompensation);
  if (matchIndentToCode === null) return text;
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(RE.beginningSpace);
      if (matchIndentInNode === null) return node;
      const [indentInNode] = matchIndentInNode;
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function tokSpace(src) {
  const cap = BLOCK.newline.exec(src);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
}

function tokCode(src) {
  const cap = BLOCK.code.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    const text = raw.replace(RE.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }
}

function tokFences(src) {
  const cap = BLOCK.fences.exec(src);
  if (cap) {
    const raw = cap[0];
    const text = indentCodeCompensation(raw, cap[3] || '');
    return {
      type: 'code',
      raw,
      lang: cap[2] ? cap[2].trim().replace(INLINE.anyPunctuation, '$1') : cap[2],
      text,
    };
  }
}

function tokHeading(src) {
  const cap = BLOCK.heading.exec(src);
  if (cap) {
    let text = cap[2].trim();
    if (RE.endingHash.test(text)) {
      const trimmed = rtrim(text, '#');
      if (!trimmed || RE.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
    }
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[1].length,
      text,
      tokens: inlineQueued(text),
    };
  }
}

function tokHr(src) {
  const cap = BLOCK.hr.exec(src);
  if (cap) return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(src) {
  const cap = BLOCK.blockquote.exec(src);
  if (cap) {
    let lines = rtrim(cap[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];

    while (lines.length > 0) {
      let inBlockquote = false;
      const currentLines = [];
      let i;
      for (i = 0; i < lines.length; i++) {
        if (RE.blockquoteStart.test(lines[i])) {
          currentLines.push(lines[i]);
          inBlockquote = true;
        } else if (!inBlockquote) {
          currentLines.push(lines[i]);
        } else {
          break;
        }
      }
      lines = lines.slice(i);

      const currentRaw = currentLines.join('\n');
      const currentText = currentRaw
        .replace(RE.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
        .replace(RE.blockquoteSetextReplace, '\n    $1')
        .replace(RE.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
      text = text ? `${text}\n${currentText}` : currentText;

      const top = CTX.state.top;
      CTX.state.top = true;
      blockTokens(currentText, tokens, true);
      CTX.state.top = top;

      if (lines.length === 0) break;

      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr' || lastToken?.type === 'html' || lastToken?.type === 'table') {
        break;
      } else if (lastToken?.type === 'blockquote') {
        const oldToken = lastToken;
        const continuation = lines.join('\n');
        const newText = oldToken.raw + '\n' + continuation.replace(RE.blockquoteSetextReplace2, '');
        const newToken = tokBlockquote(newText);
        tokens[tokens.length - 1] = newToken;
        const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
        const leftoverCount = leftover ? leftover.split('\n').length : 0;
        const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
        if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
        text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
        lines = lines.slice(consumed.length);
        if (lines.length > 0 && RE.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (lastToken?.type === 'list') {
        const oldToken = lastToken;
        const newText = oldToken.raw + '\n' + lines.join('\n');
        const newToken = tokList(newText);
        tokens[tokens.length - 1] = newToken;
        const consumedCount = newToken.raw.length > oldToken.raw.length
          ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
          : 0;
        if (consumedCount > 0) {
          const consumed = lines.slice(0, consumedCount).join('\n');
          raw = `${raw}\n${consumed}`;
          text = `${text}\n${consumed}`;
        }
        lines = lines.slice(consumedCount);
        continue;
      }
    }

    return { type: 'blockquote', raw, tokens, text };
  }
}

// First line of a string, without allocating a split array.
function firstLineOf(s) {
  const nl = s.indexOf('\n');
  return nl < 0 ? s : s.slice(0, nl);
}

// A line holding only whitespace (what String trim() would empty).
const BLANK_ONLY = /^\s*$/;

function tokList(src) {
  let cap = BLOCK.list.exec(src);
  if (cap) {
    const listSrc = src;
    const taken = () => listSrc.length - src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;

    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };

    bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

    const itemRegex = RE.listItemRegex(bull);
    let endsWithBlankLine = false;
    while (src) {
      let endEarly = false;
      let itemContents = '';
      if (!(cap = itemRegex.exec(src))) break;
      if (BLOCK.hr.test(src)) break;

      const itemStart = taken();
      src = src.substring(cap[0].length);

      const firstLine = firstLineOf(cap[2]);
      const bulletIndent = cap[1].length;
      let line = firstLine.replace(RE.leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
      let nextLine = firstLineOf(src);
      let blankLine = !line.trim();

      let indent = 0;
      if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = line.search(RE.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }

      if (blankLine && RE.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        endEarly = true;
      }

      if (!endEarly) {
        const nextBulletRegex = RE.nextBulletRegex(indent);
        const hrRegex = RE.hrRegex(indent);
        const fencesBeginRegex = RE.fencesBeginRegex(indent);
        const headingBeginRegex = RE.headingBeginRegex(indent);
        const htmlBeginRegex = RE.htmlBeginRegex(indent);
        const blockquoteBeginRegex = RE.blockquoteBeginRegex(indent);

        while (src) {
          const rawLine = firstLineOf(src);
          nextLine = rawLine;
          // Expand a leading tab run only when the line has leading
          // whitespace; otherwise the replace is a wasted scan.
          const nextLineWithoutTabs = (nextLine[0] === ' ' || nextLine[0] === '\t')
            ? nextLine.replace(RE.leadingSpaceTab, (whitespace) => expandTabs(whitespace))
            : nextLine;
          const nl0 = nextLine[0];

          // Each begin-pattern is anchored and can only match from its
          // trigger character; skip the test otherwise. Order is marked's.
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '`' || nl0 === '~') && fencesBeginRegex.test(nextLine)) break;
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '#') && headingBeginRegex.test(nextLine)) break;
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '<') && htmlBeginRegex.test(nextLine)) break;
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '>') && blockquoteBeginRegex.test(nextLine)) break;
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '*' || nl0 === '-' || nl0 === '+' || (nl0 >= '0' && nl0 <= '9')) && nextBulletRegex.test(nextLine)) break;
          if ((nl0 === ' ' || nl0 === '\t' || nl0 === '-' || nl0 === '_' || nl0 === '*') && hrRegex.test(nextLine)) break;

          const nextBlank = BLANK_ONLY.test(nextLine);
          if (nextLineWithoutTabs.search(RE.nonSpaceChar) >= indent || nextBlank) {
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            if (blankLine) break;
            const l0 = line[0];
            if ((line.includes('\t') ? line.replace(RE.tabCharGlobal, '    ') : line).search(RE.nonSpaceChar) >= 4) break;
            if ((l0 === ' ' || l0 === '\t' || l0 === '`' || l0 === '~') && fencesBeginRegex.test(line)) break;
            if ((l0 === ' ' || l0 === '\t' || l0 === '#') && headingBeginRegex.test(line)) break;
            if ((l0 === ' ' || l0 === '\t' || l0 === '<') && htmlBeginRegex.test(line)) break;
            if ((l0 === ' ' || l0 === '\t' || l0 === '-' || l0 === '_' || l0 === '*') && hrRegex.test(line)) break;

            const setextContinuation = (nl0 === ' ' || nl0 === '\t' || nl0 === '=' || nl0 === '-')
              && /^ {0,3}(?:=+|-+) *$/.test(nextLine)
              && BLOCK.lheading.test(`${line}\n${nextLine}`);
            const continuation = setextContinuation
              ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
              : nextLine;
            itemContents += '\n' + continuation;
          }

          blankLine = nextBlank;
          src = src.substring(rawLine.length + 1);
          line = nextLineWithoutTabs.slice(indent);
        }
      }

      const raw = listSrc.slice(itemStart, taken());

      if (!list.loose) {
        if (endsWithBlankLine) list.loose = true;
        else if (RE.doubleBlankLine.test(raw)) endsWithBlankLine = true;
      }

      list.items.push({
        type: 'list_item',
        raw,
        task: !!RE.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }

    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      return;
    }
    list.raw = listSrc.slice(0, taken()).trimEnd();

    for (const item of list.items) {
      CTX.state.top = false;
      item.tokens = blockTokens(item.text, []);
      if (!list.loose) {
        const spacers = item.tokens.filter((t) => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => RE.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }

    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(RE.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(RE.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(RE.listReplaceTask, '');
        for (let i = CTX.inlineQueue.length - 1; i >= 0; i--) {
          if (RE.listIsTask.test(CTX.inlineQueue[i].src)) {
            CTX.inlineQueue[i].src = CTX.inlineQueue[i].src.replace(RE.listReplaceTask, '');
            break;
          }
        }

        const taskRaw = RE.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') token.type = 'paragraph';
        }
      }
    }

    return list;
  }
}

function tokHtml(src) {
  const cap = BLOCK.html.exec(src);
  if (cap) {
    const raw = trimTrailingBlankLines(cap[0]);
    return {
      type: 'html',
      block: true,
      raw,
      pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
      text: raw,
    };
  }
}

function tokDef(src) {
  const cap = BLOCK.def.exec(src);
  if (cap) {
    if (!RE.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return;
    const tag = normalizeLabel(cap[1]);
    const href = cap[2] ? cap[2].replace(RE.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(INLINE.anyPunctuation, '$1') : cap[3];
    return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
  }
}

function tokTable(src) {
  const cap = BLOCK.table.exec(src);
  if (!cap) return;
  if (!RE.tableDelimiter.test(cap[2])) return;

  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(RE.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(RE.tableRowBlankLine, '').split('\n') : [];

  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };

  if (headers.length !== aligns.length) return;

  for (const align of aligns) {
    if (RE.tableAlignRight.test(align)) item.align.push('right');
    else if (RE.tableAlignCenter.test(align)) item.align.push('center');
    else if (RE.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }

  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      tokens: inlineQueued(headers[i]),
      header: true,
      align: item.align[i],
    });
  }

  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: inlineQueued(cell),
      header: false,
      align: item.align[i],
    })));
  }

  return item;
}

function tokLheading(src) {
  const cap = BLOCK.lheading.exec(src);
  if (cap) {
    const text = cap[1].trim();
    return {
      type: 'heading',
      raw: rtrim(cap[0], '\n'),
      depth: cap[2].charAt(0) === '=' ? 1 : 2,
      text,
      tokens: inlineQueued(text),
    };
  }
}

function tokParagraph(src) {
  const cap = BLOCK.paragraph.exec(src);
  if (cap) {
    const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
    return { type: 'paragraph', raw: cap[0], text, tokens: inlineQueued(text) };
  }
}

function tokText(src) {
  const cap = BLOCK.text.exec(src);
  if (cap) {
    return { type: 'text', raw: cap[0], text: cap[0], tokens: inlineQueued(cap[0]) };
  }
}

// Queue an inline pass for later (after the block pass collects all link
// definitions); returns the token array the pass will fill in.
function inlineQueued(src) {
  const tokens = [];
  CTX.inlineQueue.push({ src, tokens });
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenizers (marked src/Tokenizer.ts, inline half)
// ---------------------------------------------------------------------------

function tokEscape(src) {
  const cap = INLINE.escape.exec(src);
  if (cap) return { type: 'escape', raw: cap[0], text: cap[1] };
}

function tokTag(src) {
  const cap = INLINE.tag.exec(src);
  if (cap) {
    if (!CTX.state.inLink && RE.startATag.test(cap[0])) CTX.state.inLink = true;
    else if (CTX.state.inLink && RE.endATag.test(cap[0])) CTX.state.inLink = false;
    if (!CTX.state.inRawBlock && RE.startPreScriptTag.test(cap[0])) CTX.state.inRawBlock = true;
    else if (CTX.state.inRawBlock && RE.endPreScriptTag.test(cap[0])) CTX.state.inRawBlock = false;
    return {
      type: 'html',
      raw: cap[0],
      inLink: CTX.state.inLink,
      inRawBlock: CTX.state.inRawBlock,
      block: false,
      text: cap[0],
    };
  }
}

function tokLink(src) {
  if (CTX.state.linkParenPossible === false) return undefined;
  const cap = INLINE.link.exec(src);
  if (cap) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;

    const trimmedUrl = cap[2].trim();
    if (RE.startAngleBracket.test(trimmedUrl)) {
      if (!RE.endAngleBracket.test(trimmedUrl)) return;
      const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
      if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return;
    } else {
      const lastParenIndex = findClosingBracket(cap[2], '()');
      if (lastParenIndex === -2) return;
      if (lastParenIndex > -1) {
        const start = cap[0].indexOf('!') === 0 ? 5 : 4;
        const linkLen = start + cap[1].length + lastParenIndex;
        cap[2] = cap[2].substring(0, lastParenIndex);
        cap[0] = cap[0].substring(0, linkLen).trim();
        cap[3] = '';
      }
    }
    // The ')' that ends the match is the link closer only when it is not escaped.
    const unescaped = rtrim(cap[0].slice(0, -1), '\\');
    if ((cap[0].length - unescaped.length) % 2 === 0) return;
    let href = cap[2];
    const title = cap[3] ? cap[3].slice(1, -1) : '';
    href = href.trim();
    if (RE.startAngleBracket.test(href)) href = href.slice(1, -1);
    return outputLink(cap, {
      href: href ? href.replace(INLINE.anyPunctuation, '$1') : href,
      title: title ? title.replace(INLINE.anyPunctuation, '$1') : title,
    }, cap[0]);
  }
}

function tokReflink(src) {
  let cap;
  if ((cap = INLINE.reflink.exec(src)) || (cap = INLINE.nolink.exec(src))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return;
    const link = CTX.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { type: 'text', raw: text, text };
    }
    return outputLink(cap, link, cap[0]);
  }
}

function tokEmStrong(src, maskedSrc, prevChar = '') {
  let match = INLINE.emStrongLDelim.exec(src);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;

  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;

  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);

  // _ can't be between two alphanumerics
  if (match[4] && prevChar.match(RE.unicodeAlphaNumeric)) return;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;

    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossibleEmStrongCloserIndex = cachedLastEmStrongCloserIndex(maskedSrc, delimChar);
    const emStrongCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleEmStrongCloserIndex < emStrongCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleEmStrongCloserIndexInWindow = lastPossibleEmStrongCloserIndex - emStrongCloserWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleEmStrongCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip single * in __abc*abc__
      rLength = [...rDelim].length;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text) };
    }
  }
}

function tokCodespan(src) {
  const cap = INLINE.code.exec(src);
  if (cap) {
    let text = cap[2].replace(RE.newLineCharGlobal, ' ');
    const hasNonSpaceChars = RE.nonSpaceChar.test(text);
    const hasSpaceCharsOnBothEnds = RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
    if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: cap[0], text };
  }
}

function tokBr(src) {
  const cap = INLINE.br.exec(src);
  if (cap) return { type: 'br', raw: cap[0] };
}

function tokDel(src, maskedSrc, prevChar = '') {
  let match = INLINE.delLDelim.exec(src);
  if (!match) return;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;

    const endReg = INLINE.delRDelim;
    const lastPossibleDelCloserIndex = cachedLastDelCloserIndex(maskedSrc);
    const delCloserWindowStart = maskedSrc.length - src.length + lLength;
    if (lastPossibleDelCloserIndex < delCloserWindowStart) return;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastPossibleDelCloserIndexInWindow = lastPossibleDelCloserIndex - delCloserWindowStart;
    endReg.lastIndex = 0;

    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastPossibleDelCloserIndexInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;

      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }

      delimTotal -= rLength;
      if (delimTotal > 0) continue;

      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);

      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(text) };
    }
  }
}

function tokAutolink(src) {
  const cap = INLINE.autolink.exec(src);
  if (cap) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[1];
      href = 'mailto:' + text;
    } else {
      text = cap[1];
      href = text;
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokUrl(src) {
  let cap;
  if (cap = INLINE.url.exec(src)) {
    let text, href;
    if (cap[2] === '@') {
      text = cap[0];
      href = 'mailto:' + text;
    } else {
      let prevCapZero;
      do {
        prevCapZero = cap[0];
        cap[0] = INLINE._backpedal.exec(cap[0])?.[0] ?? '';
      } while (prevCapZero !== cap[0]);
      text = cap[0];
      if (cap[1] === 'www.') href = 'http://' + cap[0];
      else href = cap[0];
    }
    return {
      type: 'link',
      raw: cap[0],
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  }
}

function tokInlineText(src) {
  const cap = INLINE.text.exec(src);
  if (cap) {
    const escaped = CTX.state.inRawBlock;
    return {
      type: 'text',
      raw: cap[0],
      text: escaped ? cap[0] : decodeNumericCharacterReferences(cap[0]),
      escaped,
    };
  }
}

// ---------------------------------------------------------------------------
// Lexer (marked src/Lexer.ts)
// ---------------------------------------------------------------------------

// A setext underline line, anywhere in src: necessary (not sufficient)
// for the lheading pattern to match.
const SETEXT_LINE = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/;
// A table delimiter row, as a whole line: the table pattern's delimiter
// group, which must occupy the second line.
const TABLE_DELIM_LINE = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

function lheadingPossible(src) {
  // A setext heading's text cannot cross a blank line, so its underline
  // must sit before the first one. Only scan that far: testing the whole
  // remaining source here would be quadratic on long documents.
  const blank = src.search(/\n[ \t]*\n/);
  const head = blank < 0 ? src : src.slice(0, blank);
  return SETEXT_LINE.test(head);
}

function tablePossible(src) {
  const nl1 = src.indexOf('\n');
  if (nl1 < 0) return false;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const line2 = nl2 < 0 ? src.slice(nl1 + 1) : src.slice(nl1 + 1, nl2);
  return TABLE_DELIM_LINE.test(line2);
}

function lex(src) {
  if (src.includes('\r')) src = src.replace(RE.carriageReturn, '\n');
  const tokens = [];
  blockTokens(src, tokens);
  for (let i = 0; i < CTX.inlineQueue.length; i++) {
    const next = CTX.inlineQueue[i];
    // an inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's
    // text from being escaped
    CTX.state.inRawBlock = false;
    inlineTokens(next.src, next.tokens);
  }
  CTX.inlineQueue = [];
  return tokens;
}

function blockTokens(src, tokens = [], lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    let token;

    // newline
    if (token = tokSpace(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        // a single \n as a spacer terminates the last line, so move it there
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // code
    if (token = tokCode(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      // An indented code block cannot interrupt a paragraph.
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        CTX.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fences
    if (token = tokFences(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // heading
    if (token = tokHeading(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // hr
    if (token = tokHr(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (token = tokBlockquote(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list
    if (token = tokList(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // html
    if (token = tokHtml(src)) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // def
    if (token = tokDef(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        CTX.inlineQueue.at(-1).src = lastToken.text;
      } else {
        // The first definition of a label wins, but a later one still consumes its text
        if (!CTX.links[token.tag]) {
          CTX.links[token.tag] = { href: token.href, title: token.title };
          CTX.hasLinks = true;
        }
        tokens.push(token);
      }
      continue;
    }

    // table (gfm)
    // A table's second line must be a delimiter row; skip the (costly)
    // table pattern when it cannot be. The gate is a necessary condition:
    // the full pattern still decides.
    if (tablePossible(src) && (token = tokTable(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // lheading
    // A setext heading needs an underline line (=== or ---) after the
    // first line; skip the (costly) pattern when none can exist.
    if (lheadingPossible(src) && (token = tokLheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // top-level paragraph
    if (CTX.state.top && (token = tokParagraph(src))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        CTX.inlineQueue.pop();
        CTX.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      // lastParagraphClipped tracks whether the paragraph was clipped by an
      // extension start; with no extensions cutSrc === src, so always false.
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }

    // text
    if (token = tokText(src)) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        CTX.inlineQueue.pop();
        CTX.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  CTX.state.top = true;
  return tokens;
}

function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    // blockSkip also matches code spans and html, and the `!` of an image is
    // left out of the match, so read the character before it.
    if (INLINE.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(CTX.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    // a candidate holding a link is not a link either, so it does not count
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function inlineTokens(src, tokens = []) {
  const prevLinkParenPossible = CTX.state.linkParenPossible;
  CTX.state.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(src, tokens);
  } finally {
    CTX.state.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(src, tokens) {
  let maskedSrc = src;
  let frame = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    // Masking only matters to emStrong and del, which need a closer run.
    // If the closer scan finds none, no emphasis can form and the mask
    // (three regex passes) is pure waste; the frame is still valid for
    // the unmasked source, since masking never adds a delimiter.
    frame = scanClosers(src);
    if (frame.lastEm['*'] >= 0 || frame.lastEm['_'] >= 0 || frame.lastDel >= 0) {
      maskedSrc = maskSrc(src);
      frame = null;
    }
  }
  if (frame) CTX.hintStack.push(frame);
  else beginCloserScan(maskedSrc);
  try {
    return tokenizeInlines(src, maskedSrc, tokens);
  } finally {
    endCloserScan();
  }
}

function tokenizeInlines(src, maskedSrc, tokens) {
  let keepPrevChar = false;
  let prevChar = '';
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }

    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;

    let token;

    // First-character dispatch: every inline tokenizer's pattern is
    // anchored, so it can only match when src starts with its trigger
    // character. Trying the others first would only burn failed execs.
    // The relative order inside each group is marked's order.
    const c = src[0];
    if (c === '\\') {
      // escape, br
      if (token = tokEscape(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokBr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '<') {
      // tag, autolink
      if (token = tokTag(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokAutolink(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '[' || c === '!') {
      // link, reflink
      if (token = tokLink(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = tokReflink(src)) {
        src = src.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.type === 'text' && lastToken?.type === 'text') {
          lastToken.raw += token.raw;
          lastToken.text += token.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    } else if (c === '*' || c === '_') {
      // em & strong
      if (token = tokEmStrong(src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '`') {
      // code
      if (token = tokCodespan(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === '~') {
      // del (gfm)
      if (token = tokDel(src, maskedSrc, prevChar)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else if (c === ' ') {
      // br (two spaces + newline)
      if (token = tokBr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    } else {
      // url (gfm) — a url can start with a letter, digit or '.'; the
      // text pattern's own lookaheads stop it before a url mid-run, so
      // trying url here (before text) is exactly marked's order.
      if (!CTX.state.inLink && (token = tokUrl(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // text
    if (token = tokInlineText(src)) {
      src = src.substring(token.raw.length);
      if (token.raw.slice(-1) !== '_') { // Track prevChar before string of ____ started
        prevChar = token.raw.slice(-1);
      }
      keepPrevChar = true;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += token.raw;
        lastToken.text += token.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
  }

  return tokens;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them.
function maskSrc(src) {
  let maskedSrc = src;

  // Mask out reflinks (only when a definition exists to resolve one)
  if (CTX.hasLinks && src.includes('[')) {
    const reflinkSearch = INLINE.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(CTX.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // A candidate whose text already holds a link never becomes a link,
      // so flattening the whole span would hide the emphasis that does
      // still apply inside it. Mask the links it holds instead.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }

  // Mask out escaped characters.
  // Every mask must keep the length it replaces: emStrong and del line
  // maskedSrc up with src by slicing from the end. A backslash inside a
  // code span is literal, not an escape; mask the backticks inside the span
  // instead, so blockSkip still skips all of it.
  // Mask out escaped characters. This pattern can only match a backtick
  // run or a backslash escape, so skip it when neither is present.
  if (src.includes('\\') || src.includes('`')) {
    maskedSrc = maskedSrc.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }

  // Mask out other blocks. blockSkip can only match a link ([), a code
  // span (`) or raw HTML (<), so skip it when none of those is present.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    maskedSrc = maskedSrc.replace(INLINE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }

  return maskedSrc;
}

// ---------------------------------------------------------------------------
// Parser + renderer (marked src/Parser.ts + src/Renderer.ts + TextRenderer)
// ---------------------------------------------------------------------------

function renderTextToken(token, textMode) {
  if (textMode) return token.text;
  return 'tokens' in token && token.tokens
    ? renderInlineTokens(token.tokens)
    : ('escaped' in token && token.escaped ? token.text : escapeHtml(token.text));
}

function renderInlineTokens(tokens, textMode = false) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'escape': out += renderTextToken(token, textMode); break;
      case 'html': out += token.text; break;
      case 'link': {
        if (textMode) {
          out += token.tokens ? renderInlineTokens(token.tokens, true) : token.text;
          break;
        }
        const parsedText = token.autolink
          ? escapeHtml(token.text, true)
          : renderInlineTokens(token.tokens);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += parsedText;
          break;
        }
        let href = escapeHtml(cleanHref, token.autolink);
        let linkOut = '<a href="' + href + '"';
        if (token.title) linkOut += ' title="' + escapeHtml(token.title) + '"';
        linkOut += '>' + parsedText + '</a>';
        out += linkOut;
        break;
      }
      case 'image': {
        if (textMode) {
          out += token.tokens ? renderInlineTokens(token.tokens, true) : token.text;
          break;
        }
        let text = token.text;
        if (token.tokens) text = renderInlineTokens(token.tokens, true);
        const cleanHref = cleanUrl(token.href);
        if (cleanHref === null) {
          out += escapeHtml(text);
          break;
        }
        const href = cleanHref;
        let imgOut = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
        if (token.title) imgOut += ` title="${escapeHtml(token.title)}"`;
        imgOut += '>';
        out += imgOut;
        break;
      }
      case 'checkbox':
        out += textMode ? token.raw : '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'strong':
        out += textMode
          ? (token.tokens ? renderInlineTokens(token.tokens, true) : token.text)
          : `<strong>${renderInlineTokens(token.tokens)}</strong>`;
        break;
      case 'em':
        out += textMode
          ? (token.tokens ? renderInlineTokens(token.tokens, true) : token.text)
          : `<em>${renderInlineTokens(token.tokens)}</em>`;
        break;
      case 'codespan':
        out += textMode ? token.text : `<code>${escapeHtml(token.text, true)}</code>`;
        break;
      case 'br':
        out += textMode ? '' : '<br>';
        break;
      case 'del':
        out += textMode
          ? (token.tokens ? renderInlineTokens(token.tokens, true) : token.text)
          : `<del>${renderInlineTokens(token.tokens)}</del>`;
        break;
      case 'text':
        out += renderTextToken(token, textMode);
        break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderBlockTokens(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInlineTokens(token.tokens)}</h${token.depth}>\n`; break;
      case 'code': {
        const langString = (token.lang || '').match(RE.notSpaceStart)?.[0];
        const code = token.text ? token.text.replace(RE.endingNewline, '') + '\n' : '';
        const body = escapeHtml(code, true);
        out += langString
          ? '<pre><code class="language-' + escapeHtml(langString) + '">' + body + '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
        break;
      }
      case 'table': {
        let header = '';
        let cell = '';
        for (let j = 0; j < token.header.length; j++) cell += renderTableCell(token.header[j]);
        header += `<tr>\n${cell}</tr>\n`;
        let body = '';
        for (let j = 0; j < token.rows.length; j++) {
          const row = token.rows[j];
          cell = '';
          for (let k = 0; k < row.length; k++) cell += renderTableCell(row[k]);
          body += `<tr>\n${cell}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote': out += `<blockquote>\n${renderBlockTokens(token.tokens)}</blockquote>\n`; break;
      case 'list': {
        let body = '';
        for (let j = 0; j < token.items.length; j++) {
          body += `<li>${renderBlockTokens(token.items[j].tokens)}</li>\n`;
        }
        const type = token.ordered ? 'ol' : 'ul';
        const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html': out += token.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInlineTokens(token.tokens)}</p>\n`; break;
      case 'text': out += renderTextToken(token, false); break;
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderTableCell(token) {
  const content = renderInlineTokens(token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const prevCtx = CTX;
  CTX = newCtx();
  try {
    const tokens = lex(markdown);
    return renderBlockTokens(tokens);
  } finally {
    CTX = prevCtx;
  }
}
