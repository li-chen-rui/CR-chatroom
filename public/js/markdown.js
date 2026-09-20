/* ============================================================
   Markdown + LaTeX 渲染
   ============================================================ */

if (window.marked) {
  var renderer = new marked.Renderer();

  // 仅允许 http/https/mailto/tel 协议，杜绝 javascript: 等危险 URL
  function safeUrl(href) {
    var h = String(href || '').trim();
    if (!h) return '#';
    if (/^(https?:|mailto:|tel:|#)/i.test(h)) return h;
    if (h.charAt(0) === '/') return h; // 站内相对路径
    return '#';
  }

  renderer.link = function (href, title, text) {
    var safeHref = safeUrl(href);
    var t = title ? ' title="' + escapeHtml(title) + '"' : '';
    return '<a href="' + escapeHtml(safeHref) + '" target="_blank" rel="noopener noreferrer"' + t + '>' + text + '</a>';
  };

  renderer.image = function (href, title, text) {
    var safeHref = safeUrl(href);
    var t = title ? ' title="' + escapeHtml(title) + '"' : '';
    return '<img src="' + escapeHtml(safeHref) + '" alt="' + escapeHtml(text || '') + '"' + t + '>';
  };

  renderer.code = function (code, infostring) {
    var m = (infostring || '').match(/\S*/);
    var lang = m ? m[0] : '';
    var cls = lang ? ' class="language-' + lang + '"' : '';
    return '<pre><code' + cls + '>' + escapeHtml(code) + '</code></pre>';
  };

  marked.setOptions({
    renderer: renderer,
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
    pedantic: false,
    smartypants: false
  });
}

function protectMath(text) {
  var placeholders = [];
  var patterns = [
    /\$\$([\s\S]+?)\$\$/g,
    /\\\[([\s\S]+?)\\\]/g,
    /\\\(([\s\S]+?)\\\)/g,
    /(?<!\\)\$([^\n$]+?)(?<!\\)\$/g
  ];
  var out = text;
  patterns.forEach(function (re) {
    out = out.replace(re, function (match) {
      var id = '@@MATH_' + placeholders.length + '@@';
      placeholders.push(match);
      return id;
    });
  });
  return { text: out, placeholders: placeholders };
}

function restoreMath(html, placeholders) {
  return html.replace(/@@MATH_(\d+)@@/g, function (_, idx) {
    return placeholders[Number(idx)] || '';
  });
}

function renderMessageHtml(rawText, enableMarkdown) {
  if (!rawText) return '';
  if (!enableMarkdown) {
    return escapeHtml(rawText).replace(/\n/g, '<br>');
  }
  var r = protectMath(rawText);
  var html;
  try {
    html = window.marked ? marked.parse(r.text) : escapeHtml(r.text);
  } catch (e) {
    html = escapeHtml(r.text);
  }
  if (window.DOMPurify) {
    html = DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'class'],
      ADD_TAGS: [
        'math', 'semantics', 'annotation', 'annotation-xml',
        'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'msubsup',
        'mfrac', 'msqrt', 'mroot', 'mtext', 'mspace', 'mover', 'munder',
        'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'menclose'
      ],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+\-]+(?:[^a-z+.\-:]|$))/i
    });
  }
  return restoreMath(html, r.placeholders);
}

/* ---------- KaTeX 手工渲染（避免与 auto-render 同名冲突） ---------- */
var KATEX_DELIMS = [
  { left: '$$', right: '$$', display: true },
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
  { left: '$', right: '$', display: false }
];

var KATEX_MACROS = {
  '\\RR': '\\mathbb{R}',
  '\\NN': '\\mathbb{N}',
  '\\ZZ': '\\mathbb{Z}',
  '\\QQ': '\\mathbb{Q}',
  '\\CC': '\\mathbb{C}'
};

function renderKatexIn(root) {
  if (!root) return;
  if (!window.katex || typeof window.katex.render !== 'function') return;

  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var p = node.parentNode;
      while (p && p !== root) {
        var tag = p.nodeName ? p.nodeName.toLowerCase() : '';
        if (tag === 'script' || tag === 'noscript' || tag === 'style' ||
            tag === 'textarea' || tag === 'pre' || tag === 'code') {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.classList && (p.classList.contains('katex') || p.classList.contains('katex-display'))) {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  var textNodes = [];
  var n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (var i = 0; i < textNodes.length; i++) {
    processTextNode(textNodes[i]);
  }
}

function processTextNode(textNode) {
  var text = textNode.nodeValue;
  if (!text) return;
  if (text.indexOf('$') === -1 && text.indexOf('\\(') === -1 && text.indexOf('\\[') === -1) return;

  var matches = [];
  var cursor = 0;
  while (cursor < text.length) {
    var bestPos = -1;
    var bestDelim = null;
    for (var d = 0; d < KATEX_DELIMS.length; d++) {
      var delim = KATEX_DELIMS[d];
      var pos = text.indexOf(delim.left, cursor);
      if (pos === -1) continue;
      if (delim.left === '$' && pos > 0 && text.charAt(pos - 1) === '\\') continue;
      if (bestPos === -1 || pos < bestPos ||
          (pos === bestPos && delim.left.length > bestDelim.left.length)) {
        bestPos = pos;
        bestDelim = delim;
      }
    }
    if (bestPos === -1 || !bestDelim) break;

    var searchFrom = bestPos + bestDelim.left.length;
    var endPos = -1;
    while (true) {
      var p = text.indexOf(bestDelim.right, searchFrom);
      if (p === -1) break;
      if (bestDelim.right === '$' && p > 0 && text.charAt(p - 1) === '\\') {
        searchFrom = p + 1;
        continue;
      }
      endPos = p;
      break;
    }
    if (endPos === -1) break;

    var expr = text.slice(bestPos + bestDelim.left.length, endPos);
    matches.push({
      start: bestPos,
      end: endPos + bestDelim.right.length,
      expr: expr,
      display: bestDelim.display
    });
    cursor = endPos + bestDelim.right.length;
  }

  if (!matches.length) return;

  var frag = document.createDocumentFragment();
  var last = 0;
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    if (m.start > last) {
      frag.appendChild(document.createTextNode(text.slice(last, m.start)));
    }
    var span = document.createElement('span');
    try {
      window.katex.render(m.expr, span, {
        displayMode: !!m.display,
        throwOnError: false,
        errorColor: '#ef4444',
        macros: KATEX_MACROS
      });
    } catch (e) {
      span.textContent = (m.display ? '$$' : '$') + m.expr + (m.display ? '$$' : '$');
    }
    frag.appendChild(span);
    last = m.end;
  }
  if (last < text.length) {
    frag.appendChild(document.createTextNode(text.slice(last)));
  }

  textNode.parentNode.replaceChild(frag, textNode);
}