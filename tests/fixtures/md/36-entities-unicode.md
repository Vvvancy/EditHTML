---
title: 实体与 Unicode 😀
tags: [entities, unicode, 中文]
---

# 实体与 Unicode {#eu1}

HTML 实体：&amp; &lt; &gt; &quot; &nbsp; &copy; &#169; &#x1F680; &#25991; —— CommonMark 会解码这些实体。 ^eu2

字面字符：AT&T、a < b、c > d、"引号" 'single'、反斜杠 \\ 与 \n。 ^eu3

`代码中的 &amp; 不解码，< 保持原样` ^eu4

```html {#eu5}
<script>alert("</script>")</script> &amp; &lt;
```

中文、日本語、한국어、العربية、עברית、Emoji 👨‍👩‍👧‍👦 🇨🇳 👍🏽、辅助平面 𝒳 𠀀 𪚥。 ^eu6

双向混排 bidi：English مرحبا 123 世界 שלום end. ^eu7

全角符号：，。！？「」（）【】——……　全角空格↑ ^eu8

<p data-eh="eu9" onclick="alert(1)">Markdown 中的原始 HTML 块，带 onclick —— 预期：清洗后保留为 p，或作为外来块？</p>

[javascript 链接](javascript:alert(1)) —— 预期：href 被剔除。 ^eu10
