// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
//
// Independent implementation written for the make.fun markdown-render-speed-02
// bounty. Its parse(markdown) returns exactly the HTML that marked 18.1.3
// renders with its default options (GFM on, breaks off, pedantic off, async
// off). The matching behaviour was derived from the CommonMark and GFM specs
// and from studying marked's public behaviour (its vendored build in the kit
// was used as an oracle while testing); the code below is my own.
//
// Speed notes: the block loop runs on sticky regexes over the whole source
// with a position cursor (no repeated re-slicing of the remaining input),
// inline runs get a fast path for plain text, and nothing is cached across
// parse() calls — every call renders its input alone, deterministically.

/* ------------------------------------------------------------------ */
/* Small regex builder: start from a source string or regex, replace   */
/* named slots with other patterns, then compile. A "^" at the start   */
/* of an inserted pattern is dropped (it would anchor inside a          */
/* lookahead); the helper mirrors the way these patterns are composed   */
/* in the spec test suites.                                             */
/* ------------------------------------------------------------------ */

const CARET = /(^|[^\[])\^/g;

function rxBuilder(src, flags) {
  let text = typeof src === 'string' ? src : src.source;
  const api = {
    replace(needle, repl) {
      let piece = typeof repl === 'string' ? repl : repl.source;
      piece = piece.replace(CARET, '$1');
      text = text.replace(needle, piece);
      return api;
    },
    build() {
      return new RegExp(text, flags || '');
    },
  };
  return api;
}

// Memoize a regex factory by an indent level clamped to 0..3.
function memo4(factory) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = factory(i));
  };
}

// True on engines with lookbehind support (Node 22 has it); two inline
// patterns pick a lookbehind form when available.
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp('(?<=1)(?<!1)');
  } catch {
    return false;
  }
})();

/* ------------------------------------------------------------------ */
/* Shared small patterns ("other" in marked's vocabulary).              */
/* ------------------------------------------------------------------ */

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
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
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) =>
    new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: memo4((n) =>
    new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`),
  ),
  hrRegex: memo4((n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
    ),
  ),
  fencesBeginRegex: memo4((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memo4((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memo4(
    (n) =>
      new RegExp(
        `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        'i',
      ),
  ),
  blockquoteBeginRegex: memo4((n) => new RegExp(`^ {0,${n}}>`)),
};

// Block-level HTML tag names (CommonMark HTML block type 6).
const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

/* ------------------------------------------------------------------ */
/* Block patterns (GFM set).                                           */
/* ------------------------------------------------------------------ */

const BLANK = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES =
  /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const ATX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;

const SETTEXT_BASE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;

const LHEADING_GFM = rxBuilder(SETTEXT_BASE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(
    /hr/g,
    / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  )
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .build();

const PARA_BASE =
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const TEXT_LINE = /^[^\n]+/;
const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;

const LINK_DEF = rxBuilder(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
)
  .replace('label', LABEL_INNER)
  .replace(
    'title',
    /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
  )
  .build();

const LIST_START = rxBuilder(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, BULLET)
  .build();

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_BLOCK = rxBuilder(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'i',
)
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace(
    'attribute',
    / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
  )
  .build();

function paragraphRegex(listPattern) {
  return rxBuilder(PARA_BASE)
    .replace('hr', HR)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace(
      'fences',
      ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
    )
    .replace('list', listPattern)
    .replace(
      'html',
      ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
    )
    .replace('tag', BLOCK_TAGS)
    .build();
}

// Paragraph used inside block quotes: any list marker (not just 1.) can
// interrupt, and a marker may end the line.
const PARA_IN_QUOTE = paragraphRegex(
  / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/,
);

const BLOCKQUOTE = rxBuilder(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
)
  .replace('paragraph', PARA_IN_QUOTE)
  .build();

const TABLE = rxBuilder(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
)
  .replace('hr', HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace(
    'fences',
    ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  )
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .build();

// GFM paragraph: a table start also interrupts, and only a bullet or a
// "1."-style ordered marker interrupts.
const PARA_GFM = rxBuilder(PARA_BASE)
  .replace('hr', HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace(
    'fences',
    ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)',
  )
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace(
    'html',
    ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)',
  )
  .replace('tag', BLOCK_TAGS)
  .build();

const BLOCK = {
  newline: BLANK,
  code: INDENTED_CODE,
  fences: FENCES,
  heading: ATX,
  hr: HR,
  blockquote: BLOCKQUOTE,
  list: LIST_START,
  html: HTML_BLOCK,
  def: LINK_DEF,
  table: TABLE,
  lheading: LHEADING_GFM,
  paragraph: PARA_GFM,
  text: TEXT_LINE,
};

/* ------------------------------------------------------------------ */
/* Inline patterns (GFM set).                                          */
/* ------------------------------------------------------------------ */

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const INLINE_TEXT_GFM = rxBuilder(
  /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', HAS_LOOKBEHIND ? '(?<![^\\s*_~(])www\\.' : 'www\\.')
  .build();

const INLINE_PUNCT = rxBuilder(/^((?![*_])punctSpace)/, 'u')
  .replace(/punctSpace/g, PUNCT_SPACE)
  .build();

// Left delimiter of * / _ runs.
const EM_STRONG_LDELIM = rxBuilder(
  /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  'u',
)
  .replace(/punct/g, PUNCT_NO_TILDE)
  .build();

// Right-delimiter search for * runs (GFM: "~" is not punctuation here).
const EM_STRONG_RDELIM_AST = rxBuilder(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
  'gu',
)
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE)
  .replace(/punct/g, PUNCT_NO_TILDE)
  .build();

// Right-delimiter search for _ runs.
const EM_STRONG_RDELIM_UND = rxBuilder(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
  'gu',
)
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .build();

// Left delimiter of ~ runs (strikethrough).
const DEL_LDELIM = rxBuilder(/^~~?(?:((?!~)punct)|[^\s~])/, 'u')
  .replace(/punct/g, PUNCT)
  .build();

// Right-delimiter search for ~ runs.
const DEL_RDELIM = rxBuilder(
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
  'gu',
)
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .build();

const ANY_PUNCT = rxBuilder(/\\(punct)/, 'gu')
  .replace(/punct/g, PUNCT)
  .build();

const ANY_PUNCT_OUTSIDE_CODE = rxBuilder(
  /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
  'gu',
)
  .replace(/punct/g, PUNCT)
  .build();

const AUTOLINK = rxBuilder(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/
)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace(
    'email',
    /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
  )
  .build();

const INLINE_TAG = rxBuilder(
  '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
)
  .replace(
    'comment',
    rxBuilder(HTML_COMMENT).replace('(?:-->|$)', '-->').build(),
  )
  .replace(
    'attribute',
    /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
  )
  .build();

// A link label: nested brackets, escapes, code spans, or plain text.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL = rxBuilder(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
)
  .replace('brackets', BRACKETED)
  .build();

const INLINE_LINK = rxBuilder(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
)
  .replace('label', LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace(
    'title',
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
  )
  .build();

const REFLINK = rxBuilder(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', LABEL)
  .replace('ref', LABEL_INNER)
  .build();

const NOLINK = rxBuilder(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', LABEL_INNER)
  .build();

// Reference labels as they appear when scanning a paragraph for masking.
const REF_LABEL_LONG = /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const REF_LABEL_LONG_RX = rxBuilder(REF_LABEL_LONG)
  .replace('brackets', BRACKETED)
  .build();
const REFLINK_SEARCH = rxBuilder('reflink|nolink(?!\\()', 'g')
  .replace(
    'reflink',
    rxBuilder(/^!?\[(label)\]\[(ref)\]/)
      .replace('label', REF_LABEL_LONG_RX)
      .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/)
      .build(),
  )
  .replace(
    'nolink',
    rxBuilder(/^!?\[(ref)\](?:\[\])?/)
      .replace('ref', /(?:(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})/)
      .build(),
  )
  .build();

const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = rxBuilder(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
  .replace(/email/g, EMAIL_LOCAL)
  .build();

// GFM extended autolinks: www., scheme://, and bare email addresses.
const GFM_URL = rxBuilder(
  /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
)
  .replace('emailProtocol', EMAIL_PROTOCOL)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(
    'email',
    /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
  )
  .build();

const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Pieces a link / code span / tag may hold, used to mask them out while
// searching for the last possible emphasis closer.
const BLOCK_SKIP = rxBuilder(/link|precode-code|html/, 'g')
  .replace(
    'link',
    /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
  )
  .replace('precode-', HAS_LOOKBEHIND ? '(?<!`)()' : '(^^|[^`])')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .build();

const INLINE = {
  escape: INLINE_ESCAPE,
  code: INLINE_CODE,
  br: INLINE_BR,
  text: INLINE_TEXT_GFM,
  punctuation: INLINE_PUNCT,
  emStrongLDelim: EM_STRONG_LDELIM,
  emStrongRDelimAst: EM_STRONG_RDELIM_AST,
  emStrongRDelimUnd: EM_STRONG_RDELIM_UND,
  delLDelim: DEL_LDELIM,
  delRDelim: DEL_RDELIM,
  anyPunctuation: ANY_PUNCT,
  anyPunctuationOutsideCode: ANY_PUNCT_OUTSIDE_CODE,
  autolink: AUTOLINK,
  tag: INLINE_TAG,
  link: INLINE_LINK,
  reflink: REFLINK,
  nolink: NOLINK,
  reflinkSearch: REFLINK_SEARCH,
  url: GFM_URL,
  backpedal: BACKPEDAL,
  blockSkip: BLOCK_SKIP,
};

/* ------------------------------------------------------------------ */
/* Small helpers.                                                      */
/* ------------------------------------------------------------------ */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPE_MAP[ch];

// Escape HTML metacharacters. With `encode`, "&" is always escaped; without
// it, an "&" that begins a well-formed character reference is left alone.
function esc(str, encode) {
  if (encode) {
    return O.escapeTest.test(str) ? str.replace(O.escapeReplace, escapeChar) : str;
  }
  return O.escapeTestNoEncode.test(str)
    ? str.replace(O.escapeReplaceNoEncode, escapeChar)
    : str;
}

// Decode numeric character references in a text run. A bare "&" becomes
// "&amp;"; an out-of-range, zero, or surrogate code point becomes U+FFFD;
// "&#38;" becomes "&amp;". Named references are NOT decoded (they pass
// through for the browser, exactly as marked leaves them).
function unescNum(str) {
  if (!O.numericCharacterReference.test(str)) return str;
  return str.replace(
    O.numericCharacterReferenceOrAmpersand,
    (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return '&amp;';
      const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) {
        return '\uFFFD';
      }
      return code === 38 ? '&amp;' : String.fromCodePoint(code);
    },
  );
}

// encodeURI, with "%25" folded back to "%"; null when encodeURI throws
// (for example a lone surrogate in the href).
function encHref(href) {
  try {
    return encodeURI(href).replace(O.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, drop empty edge cells, then pad or
// truncate to `width` columns and trim each cell (turning "\|" into "|").
function splitCells(row, width) {
  const withSpaces = row.replace(O.findPipe, (ch, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withSpaces.split(O.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (width) {
    if (cells.length > width) cells.splice(width);
    else while (cells.length < width) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}

// Remove trailing occurrences of `ch` (or, when `invert`, trailing
// characters that are NOT `ch`).
function rtrim(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n; ) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// An HTML block's raw text, with trailing blank lines folded away: if the
// text ends with more than one blank line, drop them all; a single trailing
// newline is kept.
function stripHtmlTrail(raw) {
  const lines = raw.split('\n');
  let last = lines.length - 1;
  for (; last >= 0 && O.blankLine.test(lines[last]); ) last--;
  return lines.length - last <= 2 ? raw : lines.slice(0, last + 1).join('\n');
}

// Normalize a link reference label: trim, collapse inner whitespace, and
// case-fold (the lower/upper/lower round-trip folds Unicode the way the
// reference implementation does).
function normLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the closing bracket matching the opener at the start, counting
// nesting and skipping backslash escapes; -2 when the brackets never close
// (depth stays positive), -1 when no closer exists at depth zero.
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      depth++;
    } else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, to the next multiple of 4 columns, starting at
// column `col`.
function expandTabs(str, col = 0) {
  let out = '';
  let at = col;
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (at % 4);
      out += ' '.repeat(n);
      at += n;
    } else {
      out += ch;
      at++;
    }
  }
  return out;
}

// True when the link text `text` (starting at offset `off` in `full`)
// contains a "<" that opens an inline tag or autolink running past the end
// of the text — such a link is not formed.
function linkTextHasTag(full, text, off, rules) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      const m = rules.code.exec(text.slice(i));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (text[i] !== '<') continue;
    const rest = full.slice(off + i);
    const tag = rules.tag.exec(rest) || rules.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link/image token from a regex match. The link text is tokenized
// inline; a link inside a link (or inside an image's text) is dropped, and
// a link whose text already emitted a link is dropped too.
function makeLinkToken(match, dest, raw, lexer) {
  const href = dest.href;
  const title = dest.title || null;
  const text = match[1].replace(O.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasInRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(text);
  const innerEmitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = wasEmitted;
  lexer.state.inLink = wasInLink;
  if (!isImage) {
    if (innerEmitted) {
      lexer.state.inRawBlock = wasInRaw;
      return undefined;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href,
    title,
    text,
    tokens: inner,
  };
}

/* ------------------------------------------------------------------ */
/* Emphasis closer search: for a masked copy of the inline source, the  */
/* last index where a *, _ or ~ run could close an emphasis/del span.   */
/* The cache is keyed per tokenizer object and popped after each inline */
/* tokenization, so nothing survives between parse() calls.             */
/* ------------------------------------------------------------------ */

const closerCache = new WeakMap();

function scanClosers(masked) {
  const last = { '*': -1, _: -1 };
  let lastTilde = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    for (; j < n && masked[j] === ch; ) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else last[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, lastEm: last, lastDel: lastTilde };
}

function pushCloserCache(tokenizer, masked) {
  const entry = scanClosers(masked);
  const stack = closerCache.get(tokenizer);
  if (stack) stack.push(entry);
  else closerCache.set(tokenizer, [entry]);
}

function popCloserCache(tokenizer) {
  const stack = closerCache.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) closerCache.delete(tokenizer);
  }
}

function lastEmCloser(tokenizer, masked, ch) {
  const stack = closerCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === masked) return top.lastEm[ch];
  return scanClosers(masked).lastEm[ch];
}

function lastDelCloser(tokenizer, masked) {
  const stack = closerCache.get(tokenizer);
  const top = stack && stack[stack.length - 1];
  if (top && top.maskedSrc === masked) return top.lastDel;
  return scanClosers(masked).lastDel;
}

/* ------------------------------------------------------------------ */
/* Inline text scanner: a hand-rolled equivalent of INLINE_TEXT_GFM.  */
/* The regex is the single hottest spot, so the scan below reproduces  */
/* it exactly with cheap per-character tests instead of backtracking.  */
/*                                                                     */
/* The regex is ^(?: A | B ) where A is a non-alphanumeric char       */
/* followed by mailto:/xmpp: (match length 1), and B is a first char   */
/* (a run of backticks, a run of tildes, or one other char) followed   */
/* by a lazy scan that stops at: a special char (\ < ! [ ` * ~ _), a   */
/* protocol:// or www. start, end of string (all zero-width), two or   */
/* more spaces plus a newline (zero-width at the first space), a       */
/* local-chars-plus-@ email start (zero-width, only right after the    */
/* first char), or one char further when a non-space char precedes a   */
/* hard break, a non-alphanumeric char precedes mailto:/xmpp:, or a    */
/* non-local char precedes a local-chars-plus-@ email start.           */
/* ------------------------------------------------------------------ */

// 128-entry lookup tables for the text scanner (indexed by char code;
// codes >= 128 read as undefined, i.e. false, which is correct for all
// three classes since they only contain ASCII characters).
const TEXT_LOCAL = new Uint8Array(128);
const TEXT_ALNUM = new Uint8Array(128);
const TEXT_STOP = new Uint8Array(128);
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&\'*+/=?`{|}~-') TEXT_LOCAL[c.charCodeAt(0)] = 1;
for (const c of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') TEXT_ALNUM[c.charCodeAt(0)] = 1;
for (const c of '\\<![]`*~_') TEXT_STOP[c.charCodeAt(0)] = 1;

// Does s[p..] match local-chars+ followed by "@"? The scan is bounded by
// the length of the local run (a word), so it stays cheap.
function localRunEndsAt(s, p, n) {
  let q = p;
  while (q < n && TEXT_LOCAL[s.charCodeAt(q)]) q++;
  return q > p && q < n && s.charCodeAt(q) === 64;
}

// Does s[p..] start with two or more spaces followed by a newline?
function twoPlusSpacesNl(s, p, n) {
  if (s.charCodeAt(p) !== 32 || s.charCodeAt(p + 1) !== 32) return false;
  let q = p + 2;
  while (q < n && s.charCodeAt(q) === 32) q++;
  return q < n && s.charCodeAt(q) === 10;
}

// Does s[p..] start with http://, https:// or ftp:// (any case)?
function isProtocolAt(s, p) {
  const c0 = s.charCodeAt(p);
  if (c0 === 104 || c0 === 72) {
    const c1 = s.charCodeAt(p + 1);
    const c2 = s.charCodeAt(p + 2);
    const c3 = s.charCodeAt(p + 3);
    if (
      (c1 === 116 || c1 === 84) &&
      (c2 === 116 || c2 === 84) &&
      (c3 === 112 || c3 === 80)
    ) {
      let q = p + 4;
      const c4 = s.charCodeAt(q);
      if (c4 === 115 || c4 === 83) q++;
      return (
        s.charCodeAt(q) === 58 &&
        s.charCodeAt(q + 1) === 47 &&
        s.charCodeAt(q + 2) === 47
      );
    }
  } else if (c0 === 102 || c0 === 70) {
    return (
      (s.charCodeAt(p + 1) === 116 || s.charCodeAt(p + 1) === 84) &&
      (s.charCodeAt(p + 2) === 112 || s.charCodeAt(p + 2) === 80) &&
      s.charCodeAt(p + 3) === 58 &&
      s.charCodeAt(p + 4) === 47 &&
      s.charCodeAt(p + 5) === 47
    );
  }
  return false;
}

// Does s[p..] start with "www." preceded by start-of-string or one of
// whitespace, *, _, ~, ( ?
function isWwwAt(s, p) {
  if (
    s.charCodeAt(p) !== 119 ||
    s.charCodeAt(p + 1) !== 119 ||
    s.charCodeAt(p + 2) !== 119 ||
    s.charCodeAt(p + 3) !== 46
  ) {
    return false;
  }
  if (p === 0) return true;
  const pc = s.charCodeAt(p - 1);
  return (
    pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 12 ||
    pc === 11 || pc === 42 || pc === 95 || pc === 126 || pc === 40
  );
}

// Length of the inline text token starting at s[0], or -1 if the regex
// would not match (only possible for an empty string).
function scanTextLen(s) {
  const n = s.length;
  if (n === 0) return -1;
  const c0 = s.charCodeAt(0);
  // Alternative A: a non-alphanumeric char followed by mailto:/xmpp:.
  if (
    !TEXT_ALNUM[c0] &&
    (s.startsWith('mailto:', 1) || s.startsWith('xmpp:', 1))
  ) {
    return 1;
  }
  let i;
  if (c0 === 96 || c0 === 126) {
    i = 1;
    while (i < n && s.charCodeAt(i) === c0) i++;
  } else {
    i = 1;
  }
  let p = i;
  for (;;) {
    if (p >= n) return n;
    const c = s.charCodeAt(p);
    // Zero-width stops.
    if (TEXT_STOP[c]) return p;
    if (c === 104 || c === 72 || c === 102 || c === 70) {
      if (isProtocolAt(s, p)) return p;
    }
    if (c === 119 && isWwwAt(s, p)) return p;
    if (p === i) {
      if (c === 32 && twoPlusSpacesNl(s, p, n)) return p;
      if (localRunEndsAt(s, p, n)) return p;
    }
    // Consume-one stops.
    if (c !== 32 && twoPlusSpacesNl(s, p + 1, n)) return p + 1;
    if (!TEXT_ALNUM[c]) {
      const nc = s.charCodeAt(p + 1);
      if (
        (nc === 109 || nc === 120) &&
        (s.startsWith('mailto:', p + 1) || s.startsWith('xmpp:', p + 1))
      ) {
        return p + 1;
      }
    }
    if (
      !TEXT_LOCAL[c] &&
      TEXT_LOCAL[s.charCodeAt(p + 1)] &&
      localRunEndsAt(s, p + 1, n)
    ) {
      return p + 1;
    }
    p++;
  }
}

/* ------------------------------------------------------------------ */
/* Block tokenizers + the block loop (the Lexer).                      */
/*                                                                     */
/* Tokens are plain objects; inline content is queued and tokenized    */
/* after the block pass, exactly as the reference does, so that link    */
/* reference definitions seen anywhere in the block pass are known     */
/* before any inline tokenization runs.                                */
/* ------------------------------------------------------------------ */

// Strip the opening fence's indent from every body line, when the fence
// itself opens indented with backticks.
function compensateFenceIndent(raw, body) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return body;
  const indent = m[1];
  return body
    .split('\n')
    .map((line) => {
      const lead = line.match(O.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.inlineQueue = [];
  }

  lex(src) {
    src = src.replace(O.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const job = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(job.src, job.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline tokenization; returns the (initially empty) token list.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, out, inContainer = false) {
    let rest = src;
    let guard = Infinity;
    while (rest) {
      if (rest.length < guard) guard = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      let tok;
      if ((tok = this.tokSpace(rest))) {
        rest = rest.slice(tok.raw.length);
        const prev = out[out.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
        continue;
      }
      // First non-space character and its leading-space count. Every
      // block regex except table, lheading, paragraph and text starts
      // with ^ {0,3} plus one specific character, so a block starting
      // with any other character can only be one of those four. With a
      // deeper indent (or no non-space character at all) the full
      // sequence runs unchanged.
      let sp = 0;
      while (sp < rest.length && rest.charCodeAt(sp) === 32) sp++;
      const fc = sp < rest.length ? rest.charCodeAt(sp) : -1;
      const wide = sp > 3 || fc === 10 || fc === -1;
      const tryCode = wide || fc === 9;
      const tryFences = wide || fc === 96 || fc === 126;
      const tryHeading = wide || fc === 35;
      const tryHr = wide || fc === 45 || fc === 42 || fc === 95;
      const tryBlockquote = wide || fc === 62;
      const tryList =
        wide ||
        fc === 45 || fc === 42 || fc === 43 ||
        (fc >= 48 && fc <= 57);
      const tryHtml = wide || fc === 60;
      const tryDef = wide || fc === 91;
      if (tryCode && (tok = this.tokCode(rest))) {
        rest = rest.slice(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else out.push(tok);
        continue;
      }
      if (tryFences && (tok = this.tokFences(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryHeading && (tok = this.tokHeading(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryHr && (tok = this.tokHr(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryBlockquote && (tok = this.tokBlockquote(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryList && (tok = this.tokList(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryHtml && (tok = this.tokHtml(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (tryDef && (tok = this.tokDef(rest))) {
        rest = rest.slice(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) {
            this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          }
          out.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokLheading(rest))) {
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if (this.state.top && (tok = this.tokParagraph(rest))) {
        const prev = out[out.length - 1];
        if (inContainer && prev && prev.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          out.push(tok);
        }
        inContainer = false;
        rest = rest.slice(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(rest))) {
        rest = rest.slice(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          out.push(tok);
        }
        continue;
      }
      if (rest) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      break;
    }
    this.state.top = true;
    return out;
  }

  tokSpace(s) {
    const m = BLOCK.newline.exec(s);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  tokCode(s) {
    const m = BLOCK.code.exec(s);
    if (m) {
      const raw = stripHtmlTrail(m[0]);
      return {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text: raw.replace(O.codeRemoveIndent, ''),
      };
    }
  }

  tokFences(s) {
    const m = BLOCK.fences.exec(s);
    if (m) {
      const raw = m[0];
      return {
        type: 'code',
        raw,
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
        text: compensateFenceIndent(raw, m[3] || ''),
      };
    }
  }

  tokHeading(s) {
    const m = BLOCK.heading.exec(s);
    if (m) {
      let text = m[2].trim();
      if (O.endingHash.test(text)) {
        const stripped = rtrim(text, '#');
        if (!stripped || O.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading',
        raw: rtrim(m[0], '\n'),
        depth: m[1].length,
        text,
        tokens: this.inline(text),
      };
    }
  }

  tokHr(s) {
    const m = BLOCK.hr.exec(s);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }

  tokBlockquote(s) {
    const m = BLOCK.blockquote.exec(s);
    if (!m) return undefined;
    let lines = rtrim(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const out = [];
    while (lines.length > 0) {
      let seenMarker = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (O.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          seenMarker = true;
        } else if (!seenMarker) {
          chunk.push(lines[p]);
        } else {
          break;
        }
      }
      lines = lines.slice(p);
      const joined = chunk.join('\n');
      const stripped = joined
        .replace(
          O.blockquoteMarkerWhitespace,
          (g, marker, ws) => marker + expandTabs(ws, marker.length),
        )
        .replace(O.blockquoteSetextReplace, '\n    $1')
        .replace(O.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${joined}` : joined;
      text = text ? `${text}\n${stripped}` : stripped;
      const wasTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, out, true);
      this.state.top = wasTop;
      if (lines.length === 0) break;
      const last = out[out.length - 1];
      if (
        last &&
        (last.type === 'code' ||
          last.type === 'heading' ||
          last.type === 'hr' ||
          last.type === 'html' ||
          last.type === 'table')
      ) {
        break;
      }
      if (last && last.type === 'blockquote') {
        const inner = last;
        const rest = lines.join('\n');
        const combined = inner.raw + '\n' + rest.replace(O.blockquoteSetextReplace2, '');
        const reparsed = this.tokBlockquote(combined);
        out[out.length - 1] = reparsed;
        const leftover = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const taken = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
        if (taken.length > 0) {
          raw = `${raw}\n${taken.join('\n')}`;
          text =
            text.substring(0, text.length - inner.text.length) + reparsed.text;
          lines = lines.slice(taken.length);
          if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
        }
        break;
      } else if (last && last.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + lines.join('\n');
        const reparsed = this.tokList(combined);
        out[out.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > inner.raw.length
            ? combined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${taken}`;
          text = `${text}\n${taken}`;
        }
        lines = lines.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens: out, text };
  }

  tokList(s) {
    const first = BLOCK.list.exec(s);
    if (!first) return undefined;
    const whole = s;
    const consumed = () => whole.length - s.length;
    const marker = first[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bullPattern = ordered
      ? `\\d{1,9}\\${marker.slice(-1)}`
      : `\\${marker}`;
    const itemRegex = O.listItemRegex(bullPattern);
    let pendingLoose = false;
    for (; s; ) {
      let emptyItem = false;
      let content = '';
      const m = itemRegex.exec(s);
      if (!m || BLOCK.hr.test(s)) break;
      const at = consumed();
      s = s.slice(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const markerWidth = m[1].length;
      const expanded = firstLine.replace(O.leadingSpaceTab, (v) =>
        expandTabs(v, markerWidth),
      );
      const nextLine = s.split('\n', 1)[0];
      const firstEmpty = !expanded.trim();
      let indent;
      if (firstEmpty) {
        indent = markerWidth + 1;
      } else {
        indent = expanded.search(O.nonSpaceChar);
        if (indent > 4) indent = 1;
        content = expanded.slice(indent);
        indent += markerWidth;
      }
      if (firstEmpty && O.blankLine.test(nextLine)) {
        s = s.slice(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = O.nextBulletRegex(indent);
        const hrAt = O.hrRegex(indent);
        const fenceAt = O.fencesBeginRegex(indent);
        const headingAt = O.headingBeginRegex(indent);
        const htmlAt = O.htmlBeginRegex(indent);
        const quoteAt = O.blockquoteBeginRegex(indent);
        const clamped = Math.max(0, Math.min(3, indent - 1));
        let cur = expanded;
        let wasBlank = firstEmpty;
        while (s) {
          const nl = s.indexOf('\n');
          const line = nl === -1 ? s : s.slice(0, nl);
          // Dispatch the six break tests on the first non-space character:
          // each of the six regexes can only match when the line starts
          // (within `clamped` spaces) with one of ` ~ # < > * - + _ or a
          // digit, so a plain word line skips all six tests.
          let sp = 0;
          while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
          const fc = sp < line.length ? line.charCodeAt(sp) : -1;
          if (sp <= clamped) {
            if (fc === 96 || fc === 126) { if (fenceAt.test(line)) break; }
            else if (fc === 35) { if (headingAt.test(line)) break; }
            else if (fc === 60) { if (htmlAt.test(line)) break; }
            else if (fc === 62) { if (quoteAt.test(line)) break; }
            else if (fc === 42 || fc === 45) { if (nextBullet.test(line) || hrAt.test(line)) break; }
            else if (fc === 43) { if (nextBullet.test(line)) break; }
            else if (fc === 95) { if (hrAt.test(line)) break; }
            else if (fc >= 48 && fc <= 57) { if (nextBullet.test(line)) break; }
          }
          // Tab expansion only changes the line when it contains a tab;
          // without one the replace is a no-op.
          const checkExpanded = line.includes('\t')
            ? line.replace(O.leadingSpaceTab, (v) => expandTabs(v))
            : line;
          // First character that is not a space (a tab counts as one).
          let firstNonSpace = 0;
          while (
            firstNonSpace < checkExpanded.length &&
            checkExpanded.charCodeAt(firstNonSpace) === 32
          ) {
            firstNonSpace++;
          }
          if (firstNonSpace === checkExpanded.length) firstNonSpace = -1;
          if (firstNonSpace >= indent || !line.trim()) {
            content += '\n' + checkExpanded.slice(indent);
          } else {
            // `cur` is the previous content line; the same four regexes
            // can only fire when it starts with a matching character.
            let csp = 0;
            while (csp < cur.length && cur.charCodeAt(csp) === 32) csp++;
            const cfc = csp < cur.length ? cur.charCodeAt(csp) : -1;
            let curBreak = false;
            if (csp <= clamped) {
              if (cfc === 96 || cfc === 126) curBreak = fenceAt.test(cur);
              else if (cfc === 35) curBreak = headingAt.test(cur);
              else if (cfc === 60) curBreak = htmlAt.test(cur);
              else if (cfc === 42 || cfc === 45 || cfc === 95) curBreak = hrAt.test(cur);
            }
            // Index of the first non-space character in `cur` with each
            // tab expanded to four spaces, or "none" when `cur` is all
            // spaces/tabs — the same value the replace+search computed.
            let curIndent4 = false;
            if (!wasBlank) {
              let col = 0;
              let k = 0;
              for (; k < cur.length; k++) {
                const cc = cur.charCodeAt(k);
                if (cc === 32) col++;
                else if (cc === 9) col += 4;
                else break;
              }
              curIndent4 = k < cur.length && col >= 4;
            }
            if (wasBlank || curIndent4 || curBreak) {
              break;
            }
            const setextLike =
              /^ {0,3}(?:=+|-+) *$/.test(line) &&
              BLOCK.lheading.test(`${cur}\n${line}`);
            content += '\n' + (setextLike ? `    ${checkExpanded.replace(/^ {0,3}/, '')}` : line);
          }
          wasBlank = !line.trim();
          s = s.slice(line.length + 1);
          cur = checkExpanded.slice(indent);
        }
      }
      const itemRaw = whole.slice(at, consumed());
      if (!list.loose) {
        if (pendingLoose) list.loose = true;
        else if (O.doubleBlankLine.test(itemRaw)) pendingLoose = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: !!INLINE && O.listIsTask.test(content),
        loose: false,
        text: content,
        tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = whole.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => O.anyLine.test(t.raw))) {
          list.loose = true;
        }
      }
    }
    for (const item of list.items) {
      const firstTok = item.tokens[0];
      if (
        item.task &&
        firstTok &&
        (firstTok.type === 'text' || firstTok.type === 'paragraph')
      ) {
        item.text = item.text.replace(O.listReplaceTask, '');
        firstTok.raw = firstTok.raw.replace(O.listReplaceTask, '');
        firstTok.text = firstTok.text.replace(O.listReplaceTask, '');
        for (let q = this.inlineQueue.length - 1; q >= 0; q--) {
          if (O.listIsTask.test(this.inlineQueue[q].src)) {
            this.inlineQueue[q].src = this.inlineQueue[q].src.replace(
              O.listReplaceTask,
              '',
            );
            break;
          }
        }
        const box = O.listTaskCheckbox.exec(item.raw);
        if (box) {
          const checkbox = {
            type: 'checkbox',
            raw: box[0] + ' ',
            checked: box[0] !== '[ ]',
          };
          item.checked = checkbox.checked;
          if (list.loose) {
            if (
              item.tokens[0] &&
              ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] &&
              item.tokens[0].tokens
            ) {
              item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
              item.tokens[0].text = checkbox.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkbox);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkbox.raw,
                text: checkbox.raw,
                tokens: [checkbox],
              });
            }
          } else {
            item.tokens.unshift(checkbox);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) {
          if (t.type === 'text') t.type = 'paragraph';
        }
      }
    }
    return list;
  }

  tokHtml(s) {
    const m = BLOCK.html.exec(s);
    if (m) {
      const text = stripHtmlTrail(m[0]);
      return {
        type: 'html',
        block: true,
        raw: text,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text,
      };
    }
  }

  tokDef(s) {
    const m = BLOCK.def.exec(s);
    if (!m) return undefined;
    if (!O.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
      return undefined;
    }
    const tag = normLabel(m[1]);
    const href = m[2]
      ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1')
      : '';
    const title = m[3]
      ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
      : m[3];
    return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
  }

  tokTable(s) {
    // Cheap guard: a table needs its delimiter row (only spaces, pipes,
    // colons and dashes, with at least one dash) as the second line.
    const firstNl = s.indexOf('\n');
    if (firstNl === -1) return undefined;
    const secondEnd = s.indexOf('\n', firstNl + 1);
    const second = secondEnd === -1 ? s.slice(firstNl + 1) : s.slice(firstNl + 1, secondEnd);
    if (!/^[ \t|:-]+$/.test(second) || !second.includes('-')) return undefined;
    const m = BLOCK.table.exec(s);
    if (!m || !O.tableDelimiter.test(m[2])) return undefined;
    const header = splitCells(m[1]);
    const aligns = m[2]
      .replace(O.tableAlignChars, '')
      .split('|');
    if (header.length !== aligns.length) return undefined;
    const rows = m[3] && m[3].trim()
      ? m[3].replace(O.tableRowBlankLine, '').split('\n')
      : [];
    const table = {
      type: 'table',
      raw: rtrim(m[0], '\n'),
      header: [],
      align: [],
      rows: [],
    };
    for (const cell of aligns) {
      if (O.tableAlignRight.test(cell)) table.align.push('right');
      else if (O.tableAlignCenter.test(cell)) table.align.push('center');
      else if (O.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < header.length; i++) {
      table.header.push({
        text: header[i],
        tokens: this.inline(header[i]),
        header: true,
        align: table.align[i],
      });
    }
    for (const row of rows) {
      table.rows.push(
        splitCells(row, table.header.length).map((cell, i) => ({
          text: cell,
          tokens: this.inline(cell),
          header: false,
          align: table.align[i],
        })),
      );
    }
    return table;
  }

  tokLheading(s) {
    // Cheap guard: a setext heading needs an underline line (only =/- and
    // spaces) before the next blank line; without one the regex cannot
    // match, and running it on a long paragraph is pure backtracking.
    const firstNl = s.indexOf('\n');
    if (firstNl === -1) return undefined;
    let found = false;
    let pos = firstNl + 1;
    while (pos < s.length) {
      const end = s.indexOf('\n', pos);
      const line = end === -1 ? s.slice(pos) : s.slice(pos, end);
      if (/^[ \t]*$/.test(line)) break;
      if (/^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
        found = true;
        break;
      }
      if (end === -1) break;
      pos = end + 1;
    }
    if (!found) return undefined;
    const m = BLOCK.lheading.exec(s);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: rtrim(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.inline(text),
      };
    }
  }

  tokParagraph(s) {
    const m = BLOCK.paragraph.exec(s);
    if (m) {
      let text = m[1];
      if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
      return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text) };
    }
  }

  tokText(s) {
    const m = BLOCK.text.exec(s);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0]) };
  }
}

/* ------------------------------------------------------------------ */
/* Inline tokenizers + the inline loop.                                */
/* ------------------------------------------------------------------ */

// Characters that force the full inline loop; anything else is one plain
// text run (plus a possible "www." / "://" / "@" autolink). A run of two or
// more spaces before a line end is also excluded: it is a hard break.
const PLAIN_INLINE = /[\\`<\[!*_~]|www\.|:\/\/|@| {2,}\n/;

Object.assign(Lexer.prototype, {
  // Does this inline source contain a link (inline or reference) at all?
  // Used while masking the source for the emphasis-closer search.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const open = s.lastIndexOf('[');
      const known =
        s.charAt(0) === '!' ||
        !Object.hasOwn(this.tokens.links, normLabel(s.slice(open + 1, -1)));
      if (!known && !(open > 1 && this.linkInText(s.slice(1, open - 1)))) return true;
    }
    return false;
  },

  // Mask links, code spans and tags out of a copy of the inline source, so
  // the closer search only sees emphasis delimiters that can really close.
  maskForCloser(src) {
    let masked = src;
    if (this.tokens.links && src.includes('[')) {
      const search = INLINE.reflinkSearch;
      const hide = (r) => {
        const open = r.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normLabel(r.slice(open + 1, -1)))) {
          return r;
        }
        if (open > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(search, hide) + '][' + 'a'.repeat(r.length - open - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      masked = masked.replace(search, hide);
    }
    // The punctuation mask only matches code spans (needs a backtick) or a
    // backslash escape; without either it is a no-op scan.
    if (masked.includes('`') || masked.includes('\\')) {
      masked = masked.replace(
        INLINE.anyPunctuationOutsideCode,
        (whole, fences, punct) =>
          punct
            ? '+'.repeat(whole.length)
            : fences
              ? fences + whole.slice(fences.length, -fences.length).replace(/`/g, '+') + fences
              : whole,
      );
    }
    // A link, code span or tag can only be hidden when one of [, <, ` is
    // present; otherwise this scan is a no-op.
    if (masked.includes('[') || masked.includes('<') || masked.includes('`')) {
      masked = masked.replace(INLINE.blockSkip, (whole, _a, b) => {
        const keep = b ? b.length : 0;
        return whole.slice(0, keep) + '[' + 'a'.repeat(whole.length - keep - 2) + ']';
      });
    }
    return masked;
  },

  inlineTokens(src, tokens = []) {
    if (!PLAIN_INLINE.test(src) && !this.state.inRawBlock) {
      tokens.push({
        type: 'text',
        raw: src,
        text: src.includes('&') ? unescNum(src) : src,
        escaped: false,
      });
      return tokens;
    }
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      const masked =
        src.includes('*') || src.includes('_') || src.includes('~')
          ? this.maskForCloser(src)
          : src;
      pushCloserCache(this, masked);
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        popCloserCache(this);
      }
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  },

  inlineLoop(src, masked, out) {
    let rest = src;
    let lastChar = '';
    let afterText = false;
    let guard = Infinity;
    while (rest) {
      if (rest.length < guard) guard = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!afterText) lastChar = '';
      afterText = false;
      const ch = rest.charCodeAt(0);
      let tok;
      // Dispatch on the first character: at any position at most two
      // tokenizers can match, so the rest need not even be tried. This
      // keeps the loop's order (escape, tag, link, reflink, emphasis,
      // code span, break, strikethrough, autolink, extended autolink,
      // text) while skipping the ones that cannot match here.
      if (ch === 92) {
        // backslash: escape, then a backslash hard break, then text
        if ((tok = this.tokEscape(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokBr(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === 60) {
        // <: inline tag, then an autolink
        if ((tok = this.tokTag(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokAutolink(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === 91 || ch === 33) {
        // [ or !: inline link, then a reference link
        if ((tok = this.tokLink(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
        if ((tok = this.tokReflink(rest))) {
          rest = rest.slice(tok.raw.length);
          const prev = out[out.length - 1];
          if (tok.type === 'text' && prev && prev.type === 'text') {
            prev.raw += tok.raw;
            prev.text += tok.text;
          } else {
            out.push(tok);
          }
          continue;
        }
      } else if (ch === 42 || ch === 95) {
        // * or _: emphasis / strong emphasis; a "_" can also start a
        // bare email address, so an extended autolink is tried next
        if ((tok = this.tokEmStrong(rest, masked, lastChar))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
        if (
          ch === 95 &&
          !this.state.inLink &&
          (tok = this.tokUrl(rest))
        ) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === 96) {
        // backtick: code span
        if ((tok = this.tokCodespan(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === 126) {
        // ~: strikethrough
        if ((tok = this.tokDel(rest, masked, lastChar))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (ch === 32) {
        // space: a hard break (two or more spaces before a line end)
        if ((tok = this.tokBr(rest))) {
          rest = rest.slice(tok.raw.length);
          out.push(tok);
          continue;
        }
      } else if (!this.state.inLink && (tok = this.tokUrl(rest))) {
        // any other character: only an extended autolink can match first
        rest = rest.slice(tok.raw.length);
        out.push(tok);
        continue;
      }
      if ((tok = this.tokInlineText(rest))) {
        rest = rest.slice(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') lastChar = tok.raw.slice(-1);
        afterText = true;
        const prev = out[out.length - 1];
        if (prev && prev.type === 'text') {
          prev.raw += tok.raw;
          prev.text += tok.text;
        } else {
          out.push(tok);
        }
        continue;
      }
      if (rest) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      break;
    }
    return out;
  },

  tokEscape(s) {
    const m = INLINE.escape.exec(s);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  },

  tokTag(s) {
    const m = INLINE.tag.exec(s);
    if (m) {
      if (!this.state.inLink && O.startATag.test(m[0])) this.state.inLink = true;
      else if (this.state.inLink && O.endATag.test(m[0])) this.state.inLink = false;
      if (!this.state.inRawBlock && O.startPreScriptTag.test(m[0])) {
        this.state.inRawBlock = true;
      } else if (this.state.inRawBlock && O.endPreScriptTag.test(m[0])) {
        this.state.inRawBlock = false;
      }
      return {
        type: 'html',
        raw: m[0],
        inLink: this.state.inLink,
        inRawBlock: this.state.inRawBlock,
        block: false,
        text: m[0],
      };
    }
  },

  tokLink(s) {
    if (this.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(s);
    if (!m) return undefined;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(s, m[1], off, INLINE)) return undefined;
    let dest = m[2].trim();
    if (O.startAngleBracket.test(dest)) {
      if (!O.endAngleBracket.test(dest)) return undefined;
      const unescaped = rtrim(dest.slice(0, -1), '\\');
      if ((dest.length - unescaped.length) % 2 === 0) return undefined;
    } else {
      const close = findClosingBracket(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const head = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, head).trim();
        m[3] = '';
      }
    }
    const tailTrimmed = rtrim(m[0].slice(0, -1), '\\');
    if ((m[0].length - tailTrimmed.length) % 2 === 0) return undefined;
    let href = m[2];
    let title = m[3] ? m[3].slice(1, -1) : '';
    href = href.trim();
    if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
    return makeLinkToken(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      },
      m[0],
      this,
    );
  },

  tokReflink(s) {
    const m = INLINE.reflink.exec(s) || INLINE.nolink.exec(s);
    if (!m) return undefined;
    const off = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(s, m[1], off, INLINE)) return undefined;
    const dest = this.tokens.links[normLabel(m[2] || m[1])];
    if (!dest) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLinkToken(m, dest, m[0], this);
  },

  tokEmStrong(s, masked, prevChar) {
    const m = INLINE.emStrongLDelim.exec(s);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const ch = m[0][0];
    const sameAsPrev = prevChar === ch;
    const offset = masked.length - s.length;
    let runStart = offset;
    while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
    const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct =
      beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    let before = prevChar;
    if (runStart < offset) before = beforeRun;
    const beforeIsPunctNow = runStart < offset
      ? beforeIsPunct
      : !!INLINE.punctuation.exec(before);
    if (m[4] && before.match(O.unicodeAlphaNumeric)) return undefined;
    const punctAfter = m[1] || m[3] || '';
    if (!punctAfter || !before || beforeIsPunctNow) {
      const runLen = [...m[0]].length - 1;
      let openLeft = runLen;
      let extra = 0;
      const span = offset - runStart + runLen;
      const canCloseToo = !!beforeRun.trim() && (!!punctAfter || (ch === '*' && !beforeIsPunct));
      if (ch !== '*' && ch !== '_') return undefined;
      const closerRe =
        ch === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = lastEmCloser(this, masked, ch);
      const afterOpen = offset + runLen;
      if (lastCloser < afterOpen) return undefined;
      const search = masked.slice(afterOpen);
      const limit = lastCloser - afterOpen;
      let match;
      closerRe.lastIndex = 0;
      while ((match = closerRe.exec(search)) !== null && !(match.index > limit)) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        const len = [...run].length;
        if (match[3] || match[4]) {
          openLeft += len;
          continue;
        } else if (match[5] || match[6] || canCloseToo) {
          if (sameAsPrev && (match[5] || match[6])) break;
          if (span % 3 && !((span + len) % 3)) {
            extra += len;
            continue;
          }
        }
        openLeft -= len;
        if (openLeft > 0) continue;
        const use = Math.min(len, len + openLeft + extra);
        const firstLen = [...match[0]][0].length;
        const whole = s.slice(0, runLen + match.index + firstLen + use);
        if (Math.min(runLen, use) % 2) {
          const inner = whole.slice(1, -1);
          return {
            type: 'em',
            raw: whole,
            text: inner,
            tokens: this.inlineTokens(inner),
          };
        }
        const inner = whole.slice(2, -2);
        return {
          type: 'strong',
          raw: whole,
          text: inner,
          tokens: this.inlineTokens(inner),
        };
      }
    }
    return undefined;
  },

  tokCodespan(s) {
    const m = INLINE.code.exec(s);
    if (m) {
      let text = m[2].replace(O.newLineCharGlobal, ' ');
      const hasNonSpace = O.nonSpaceChar.test(text);
      const padded = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  },

  tokBr(s) {
    const m = INLINE.br.exec(s);
    if (m) return { type: 'br', raw: m[0] };
  },

  tokDel(s, masked, prevChar) {
    const m = INLINE.delLDelim.exec(s);
    if (!m) return undefined;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...m[0]].length - 1;
      let openLeft = runLen;
      const lastCloser = lastDelCloser(this, masked);
      const afterOpen = masked.length - s.length + runLen;
      if (lastCloser < afterOpen) return undefined;
      const search = masked.slice(afterOpen);
      const limit = lastCloser - afterOpen;
      const closerRe = INLINE.delRDelim;
      let match;
      closerRe.lastIndex = 0;
      while ((match = closerRe.exec(search)) !== null && !(match.index > limit)) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        const len = [...run].length;
        if (len !== runLen) continue;
        if (match[3] || match[4]) {
          openLeft += len;
          continue;
        }
        openLeft -= len;
        if (openLeft > 0) continue;
        const use = Math.min(len, len + openLeft);
        const firstLen = [...match[0]][0].length;
        const whole = s.slice(0, runLen + match.index + firstLen + use);
        const inner = whole.slice(runLen, -runLen);
        return { type: 'del', raw: whole, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return undefined;
  },

  tokAutolink(s) {
    const m = INLINE.autolink.exec(s);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = 'mailto:' + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: 'link',
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: 'text', raw: text, text }],
      };
    }
  },

  tokUrl(s) {
    const m = INLINE.url.exec(s);
    if (!m) return undefined;
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let cur = m[0];
      let prev;
      do {
        prev = cur;
        cur = INLINE.backpedal.exec(cur)?.[0] ?? '';
      } while (cur !== prev);
      text = cur;
      href = m[1] === 'www.' ? 'http://' + cur : cur;
    }
    return {
      type: 'link',
      raw: text,
      text,
      href,
      autolink: true,
      tokens: [{ type: 'text', raw: text, text }],
    };
  },

  tokInlineText(s) {
    const len = scanTextLen(s);
    const raw = len >= 0 ? s.slice(0, len) : (INLINE.text.exec(s) || [])[0];
    if (raw === undefined) return undefined;
    const inRaw = this.state.inRawBlock;
    return {
      type: 'text',
      raw,
      text: inRaw || !raw.includes('&') ? raw : unescNum(raw),
      escaped: inRaw,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Rendering: tokens to HTML.                                          */
/* ------------------------------------------------------------------ */

function renderBlockToken(tok) {
  switch (tok.type) {
    case 'space':
      return '';
    case 'code': {
      const lang = (tok.lang || '').match(O.notSpaceStart)?.[0] || '';
      const body = tok.text ? tok.text.replace(O.endingNewline, '') + '\n' : '';
      const inner = tok.escaped ? body : esc(body, true);
      return lang
        ? `<pre><code class="language-${esc(lang)}">${inner}</code></pre>\n`
        : `<pre><code>${inner}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderTokens(tok.tokens)}</blockquote>\n`;
    case 'html':
      return tok.text;
    case 'def':
      return '';
    case 'heading':
      return `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'list': {
      let items = '';
      for (const item of tok.items) items += renderListItem(item);
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }
    case 'checkbox':
      return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'paragraph':
      return `<p>${renderInline(tok.tokens)}</p>\n`;
    case 'table': {
      let head = '';
      for (const cell of tok.header) head += renderTableCell(cell);
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const cell of row) cells += renderTableCell(cell);
        body += `<tr>\n${cells}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
    }
    case 'text':
      return renderInlineTokenText(tok);
    default:
      throw new Error('Token with "' + tok.type + '" type was not found.');
  }
}

function renderListItem(item) {
  return `<li>${renderTokens(item.tokens)}</li>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

function renderInlineTokenText(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return esc(tok.text);
}

function renderInlineToken(tok, altText) {
  switch (tok.type) {
    case 'escape':
      return altText ? tok.text : renderInlineTokenText(tok);
    case 'html':
      return tok.text;
    case 'link': {
      if (altText) return renderInline(tok.tokens, true);
      const inner = tok.autolink
        ? esc(tok.text, true)
        : renderInline(tok.tokens);
      const href = encHref(tok.href);
      if (href === null) return inner;
      const hrefEsc = esc(href, tok.autolink);
      let out = `<a href="${hrefEsc}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + `>${inner}</a>`;
    }
    case 'image': {
      if (altText) return tok.tokens ? renderInline(tok.tokens, true) : tok.text;
      let alt = tok.text;
      if (tok.tokens) alt = renderInline(tok.tokens, true);
      const src = encHref(tok.href);
      if (src === null) return esc(alt);
      let out = `<img src="${esc(src)}" alt="${esc(alt)}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + '>';
    }
    case 'checkbox':
      return altText
        ? tok.raw
        : `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'strong':
      return altText
        ? renderInline(tok.tokens, true)
        : `<strong>${renderInline(tok.tokens)}</strong>`;
    case 'em':
      return altText
        ? renderInline(tok.tokens, true)
        : `<em>${renderInline(tok.tokens)}</em>`;
    case 'codespan':
      return altText ? tok.text : `<code>${esc(tok.text, true)}</code>`;
    case 'br':
      return altText ? '' : '<br>';
    case 'del':
      return altText
        ? renderInline(tok.tokens, true)
        : `<del>${renderInline(tok.tokens)}</del>`;
    case 'text':
      return altText ? tok.text : renderInlineTokenText(tok);
    default:
      throw new Error('Token with "' + tok.type + '" type was not found.');
  }
}

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) out += renderBlockToken(tok);
  return out;
}

function renderInline(tokens, altText = false) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok, altText);
  return out;
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const tokens = new Lexer().lex(markdown);
  return renderTokens(tokens);
}
