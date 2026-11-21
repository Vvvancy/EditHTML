---
title: 嵌入与脚本组件
created: 2026-11-22
tags: [embed, script]
theme: default
---

:::embed {#e1}
url: https://www.example.com/video/12345
height: 360
:::

:::embed {#e2}
url: https://example.org/page?x=1&y=2
height: 200
:::

:::script {#s1}
html: <button id="b">点我 +1</button> <span id="n">0</span>
css: button{padding:4px 8px}
js: let n=0;document.getElementById('b').onclick=()=>{document.getElementById('n').textContent=++n;};
:::

:::script {#s2}
html: <div id="clock"></div>
css: ''
js: |-
  const s=document.createElement('script');s.textContent='1<2';document.body.append(s);/* </script> must stay escaped */setInterval(()=>{clock.textContent=new Date().toLocaleTimeString('zh-CN')},1000);
:::
