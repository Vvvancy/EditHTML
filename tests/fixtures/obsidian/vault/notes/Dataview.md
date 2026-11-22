---
tags: [dataview]
status: draft
---

# Dataview

status:: active
due:: [[2026-11-30]]

带方括号的行内字段：本周评分 [rating:: 4]，以及隐藏键的圆括号写法 (mood:: 😊)。

```dataview
TABLE status, priority
FROM #project
WHERE status = "active"
SORT priority ASC
```

```dataviewjs
const pages = dv.pages('"journal"').sort(p => p.file.name, 'desc');
dv.list(pages.limit(3).file.link);
```

行内查询：`= this.file.name`，以及 JS 行内查询 `$= dv.current().file.mtime`。

```tasks
not done
due before 2026-12-01
```

```query
tag:#meeting
```
