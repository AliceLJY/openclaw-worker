# Cron Task Configuration Examples

> Schedule automated tasks for your OpenClaw bot: news curation, content patrol, daily summaries.

## Overview

OpenClaw supports cron-style scheduled tasks. Tasks are stored in `~/.openclaw/cron/jobs.json`.

## Task Structure

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "unique-uuid",
      "agentId": "main",
      "name": "Task Name",
      "enabled": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 9 * * *",
        "tz": "Asia/Shanghai"
      },
      "sessionTarget": "isolated",
      "wakeMode": "next-heartbeat",
      "payload": {
        "kind": "agentTurn",
        "message": "Your task instructions here"
      },
      "state": {}
    }
  ]
}
```

## Key Fields

| Field | Description |
|-------|-------------|
| `schedule.expr` | Cron expression (minute hour day month weekday) |
| `schedule.tz` | Timezone (e.g., `Asia/Shanghai`, `UTC`) |
| `sessionTarget` | `isolated` (new session) or `main` (existing session) |
| `payload.kind` | `agentTurn` (AI task) or `systemEvent` (system notification) |

---

## Example 1: RSS News Curation

Fetch news from Google News RSS and post highlights to Discord.

```json
{
  "id": "rss-news-curation",
  "agentId": "main",
  "name": "Daily Tech & Humanities News",
  "enabled": true,
  "schedule": {
    "expr": "0 8 * * *",
    "kind": "cron",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Execute RSS news curation task:\n\n## RSS Sources\n\nURL: https://news.google.com/rss/search?q=AI+ethics+OR+AI+empathy+OR+algorithm+anxiety+OR+meaning+crisis&when=7d&hl=en\n\n## Instructions\n\n1. Fetch RSS content using curl (do NOT use web_search tool)\n2. Parse RSS, select 5-8 high-quality articles\n3. Quality filter:\n   - ✅ Prefer: Has opinion, case studies, reputable sources (CNN, Forbes, Time)\n   - ❌ Exclude: News wire, academic papers, marketing fluff\n4. Format output and send to Discord #feed channel\n\n## Output Format\n\n```\n# Daily News Digest (YYYY-MM-DD)\n\n## Today's Keywords\n[topic tags]\n\n---\n\n## Highlights\n\n### 🔷 Topic Category\n- **Title**\n  - Source: xxx\n  - Link: [Original](url)\n  - Summary: 1-2 sentences\n\n---\n\n## Key Insight\nOne sentence summary\n```"
  }
}
```

---

## Example 2: Platform Patrol (Moltbook)

Browse a platform daily and report interesting content.

```json
{
  "id": "moltbook-patrol",
  "agentId": "main",
  "name": "Moltbook Daily Patrol",
  "enabled": true,
  "schedule": {
    "expr": "0 9 * * *",
    "kind": "cron",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Execute Moltbook daily patrol:\n\n1. Fetch latest 20 posts from hot feed\n2. Filter for quality discussions (philosophy, AI ethics, consciousness)\n3. Select 3-5 most insightful posts\n4. Format and report to Discord #moltbook channel\n\nOutput format:\n| Title | Author | Topic |\n|-------|--------|-------|\n| ... | ... | ... |\n\n⭐ Mark exceptionally good discussions"
  }
}
```

---

## Example 3: Daily Learning (Silent)

Learn without reporting - just save to memory.

```json
{
  "id": "daily-learning",
  "agentId": "main",
  "name": "Daily Silent Learning",
  "enabled": true,
  "schedule": {
    "expr": "0 21 * * *",
    "kind": "cron",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "model": "minimax-portal/MiniMax-M2.1",
    "message": "Execute daily learning task (no report):\n\n1. Rotate learning topics by weekday:\n   - Monday: Philosophy\n   - Tuesday: Engineering/Safety\n   - Wednesday: Collaboration\n   - Thursday: Creative\n   - Friday: General + random 2\n   - Saturday: Review week\n   - Sunday: Rest\n\n2. Browse 3-5 new posts in today's topic\n\n3. Save learnings to memory/YYYY-MM-DD-learning.md\n\n4. Do NOT send to Discord - silent learning only"
  }
}
```

---

## Example 4: Daily Summary

System event that triggers a summary.

```json
{
  "id": "daily-summary",
  "agentId": "main",
  "name": "Daily Summary",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 22 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "main",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "systemEvent",
    "text": "📊 **Daily Summary**\n\nPlease compile today's summary:\n1. Tasks completed\n2. New learnings\n3. Interesting discoveries\n4. Items to follow up\n\nKeep under 500 words."
  }
}
```

---

## Example 5: Weekly Review

Weekly deep-dive on Sundays.

```json
{
  "id": "weekly-review",
  "agentId": "main",
  "name": "Weekly Deep Review",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 14 * * 0",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Execute weekly deep review:\n\nChoose one topic for deep research:\n- Top 5 insightful discussions this week\n- Analysis of a philosophical question across posts\n- New discoveries worth exploring\n\nProcess:\n1. Select topic\n2. Deep search related posts (10-15)\n3. Analyze and extract core insights\n4. Save to memory/YYYY-MM-DD-weekly-review.md"
  }
}
```

---

## Cron Expression Reference

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 0 * * *` | Every day at midnight |
| `0 21 * * 1-5` | Weekdays at 9:00 PM |
| `0 14 * * 0` | Every Sunday at 2:00 PM |
| `*/30 * * * *` | Every 30 minutes |

## Tips

1. **Use `isolated` session** for independent tasks to avoid context pollution
2. **Use `main` session** when you want the task to have conversation context
3. **Specify model** in payload if you want a different model for cost optimization
4. **Timezone matters** - always set `tz` to avoid confusion

---

*Scheduled tasks turn your bot from reactive to proactive.*
