<script setup lang="ts">
import { Trans } from '@lingui/vue/macro'
</script>

<template>
  <section class="forms" aria-labelledby="forms-title">
    <div class="forms-head">
      <p class="section-kicker">TWO WAYS IN</p>
      <h2 id="forms-title"><Trans>两种接法，选顺手的</Trans></h2>
      <p class="forms-lead">
        <Trans>同一个微信入口，可以接进已有客户端，也可以让 WeMind 常驻本机。</Trans>
      </p>
    </div>

    <div class="form-grid">
      <article class="form-card">
        <p class="form-index">01</p>
        <h3>MCP Server</h3>
        <p class="form-copy">
          <Trans>接进 Claude Desktop、Cursor、OpenCode 等客户端，由客户端收消息、生成回复。</Trans>
        </p>
        <p class="form-fit"><Trans>适合：已经有常用客户端，只想补一个微信入口。</Trans></p>
      </article>

      <article class="form-card form-card--accent">
        <p class="form-index">02</p>
        <h3>daemon</h3>
        <p class="form-copy">
          <Trans>让 WeMind 常驻本机，自己收消息、调用常驻 Agent，适合长期在线和远程任务。</Trans>
        </p>
        <p class="form-fit"><Trans>适合：想要一个一直在线的微信助手。</Trans></p>
      </article>
    </div>

    <p class="form-warning">
      <Trans>两种形态不能同时跑：同一个微信 bot 只能有一个程序收消息，否则会互相抢消息。</Trans>
    </p>

    <div class="safety" aria-labelledby="safety-title">
      <h3 id="safety-title"><Trans>消息留在本机</Trans></h3>
      <ul>
        <li><Trans>在本机运行，不经过云端中转</Trans></li>
        <li><Trans>只处理白名单里的发送者</Trans></li>
        <li><Trans>敏感文件会被拦下</Trans></li>
        <li><Trans>附件有大小上限</Trans></li>
        <li><Trans>账号与数据按账号隔离</Trans></li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.forms {
  max-width: 1180px;
  margin: 0 auto;
  padding: 72px 24px 56px;
}

.forms-head {
  max-width: 760px;
}

.section-kicker {
  margin: 0 0 10px;
  color: var(--wm-clay);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
}

.forms-head h2 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: clamp(32px, 4.4vw, 52px);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.18;
}

.forms-lead {
  max-width: 620px;
  margin: 14px 0 0;
  color: var(--wm-muted);
  font-size: 15px;
  line-height: 1.8;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  margin-top: 36px;
}

.form-card {
  padding: 28px;
  border: 1px solid var(--wm-line);
  background: rgba(255, 253, 248, 0.62);
}

.form-card--accent {
  background:
    linear-gradient(180deg, rgba(231, 237, 223, 0.75), rgba(255, 253, 248, 0.72)), var(--wm-paper);
}

.form-index {
  margin: 0 0 18px;
  color: var(--wm-clay);
  font-family: var(--wm-serif);
  font-size: 13px;
}

.form-card h3 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.02em;
}

.form-copy {
  margin: 12px 0 0;
  color: var(--wm-muted);
  font-size: 14px;
  line-height: 1.8;
}

.form-fit {
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--wm-line);
  color: var(--wm-pine);
  font-size: 12px;
  line-height: 1.6;
}

.form-warning {
  margin: 16px 0 0;
  color: var(--wm-clay);
  font-size: 12px;
  line-height: 1.7;
}

.safety {
  display: grid;
  grid-template-columns: minmax(0, 0.6fr) minmax(0, 1.4fr);
  gap: 32px;
  margin-top: 56px;
  padding-top: 28px;
  border-top: 1px solid var(--wm-line);
}

.safety h3 {
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: 24px;
  font-weight: 500;
}

.safety ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.safety li {
  padding: 6px 10px;
  border: 1px solid var(--wm-line);
  border-radius: 999px;
  color: var(--wm-muted);
  font-size: 12px;
}

@media (max-width: 760px) {
  .forms {
    padding: 48px 20px 40px;
  }

  .form-grid,
  .safety {
    grid-template-columns: 1fr;
  }

  .form-card {
    padding: 22px;
  }

  .safety {
    gap: 18px;
  }
}
</style>
