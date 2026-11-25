<script setup lang="ts">
import { Trans } from '@lingui/vue/macro'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/vue'
import { useLocale } from '../composables/useLocale'

const { docsHref } = useLocale()
const { i18n } = useLingui()
const rosterLabel = msg`Agent 列表`
const githubHref = 'https://github.com/imwangpan/WeMind'
</script>

<template>
  <section class="home-hero">
    <div class="hero-copy">
      <p class="hero-eyebrow"><Trans>微信 × AI Agent</Trans></p>
      <h1>
        <span><Trans>一个微信入口，</Trans></span>
        <span><Trans>接入任意 AI Agent</Trans></span>
      </h1>
      <p class="hero-lead"><Trans>微信不用换，Agent 随心换。</Trans></p>
      <p class="hero-sub">
        <Trans
          >随时随地，在微信里切换你想用的 Agent。今天 Claude Code，明天 Codex；长任务交给
          Pi，一切尽在微信中！</Trans
        >
      </p>
      <p class="hero-scope">
        <Trans>支持 CLI 与 ACP 的 AI Agent 均可接入，完整列表见文档。</Trans>
      </p>
      <div class="hero-actions">
        <a class="button button--primary" :href="docsHref">
          <Trans>5 分钟开始</Trans>
        </a>
        <a class="button button--ghost" :href="githubHref" target="_blank" rel="noreferrer">
          <Trans>在 GitHub 查看</Trans>
        </a>
      </div>
      <p class="hero-note"><Trans>本机运行 · 不接云端中转</Trans></p>
    </div>

    <aside class="hero-sheet" :aria-label="i18n._(rosterLabel)">
      <div class="sheet-head">
        <span class="sheet-title"><Trans>今天谁接手？</Trans></span>
        <span class="sheet-stamp"><Trans>随时换</Trans></span>
      </div>
      <ul class="agent-list">
        <li class="agent-item agent-item--active">
          <span class="agent-mark">CC</span>
          <span class="agent-name">Claude Code</span>
          <span class="agent-role"><Trans>主聊</Trans></span>
        </li>
        <li class="agent-item">
          <span class="agent-mark">CX</span>
          <span class="agent-name">Codex</span>
          <span class="agent-role"><Trans>待命</Trans></span>
        </li>
        <li class="agent-item">
          <span class="agent-mark">Pi</span>
          <span class="agent-name">Pi</span>
          <span class="agent-role"><Trans>长任务</Trans></span>
        </li>
        <li class="agent-item">
          <span class="agent-mark">GM</span>
          <span class="agent-name">Gemini</span>
          <span class="agent-role"><Trans>待命</Trans></span>
        </li>
      </ul>
      <p class="sheet-note"><Trans>微信入口只有一个，Agent 可以换。</Trans></p>
      <div class="sheet-rule"></div>
      <p class="sheet-foot"><Trans>长任务可以另派一个 Agent，微信这边照常聊。</Trans></p>
    </aside>
  </section>
</template>

<style scoped>
.home-hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(320px, 0.88fr);
  gap: clamp(40px, 7vw, 96px);
  align-items: center;
  max-width: 1180px;
  min-height: 78vh;
  margin: 0 auto;
  padding: 96px 24px 72px;
}

.home-hero::before {
  position: absolute;
  top: 8%;
  right: 10%;
  width: 420px;
  height: 420px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(180, 95, 63, 0.07), transparent 68%);
  content: '';
  pointer-events: none;
}

.hero-copy {
  position: relative;
  z-index: 1;
}

.hero-eyebrow {
  margin: 0 0 18px;
  color: var(--wm-clay);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
}

h1 {
  max-width: 760px;
  margin: 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: clamp(40px, 5.3vw, 66px);
  font-weight: 500;
  letter-spacing: -0.045em;
  line-height: 1.08;
}

h1 span {
  display: block;
}

.hero-lead {
  margin: 28px 0 0;
  color: var(--wm-pine);
  font-family: var(--wm-serif);
  font-size: clamp(20px, 2.4vw, 28px);
  font-weight: 500;
  letter-spacing: -0.015em;
  line-height: 1.4;
}

.hero-sub {
  max-width: 640px;
  margin: 14px 0 0;
  color: var(--wm-muted);
  font-size: 16px;
  line-height: 1.8;
}

.hero-scope {
  max-width: 620px;
  margin: 12px 0 0;
  color: var(--wm-muted);
  font-size: 12px;
  line-height: 1.6;
  opacity: 0.82;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 30px;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 46px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 3px;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition:
    background-color 180ms ease,
    border-color 180ms ease,
    color 180ms ease;
}

.button--primary {
  background: var(--wm-pine);
  color: #fffdf8;
}

.button--primary:hover {
  background: #3f5b43;
}

.button--ghost {
  border-color: var(--wm-line);
  color: var(--wm-ink);
}

.button--ghost:hover {
  border-color: var(--wm-pine);
  color: var(--wm-pine);
}

.hero-note {
  margin: 18px 0 0;
  color: var(--wm-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.hero-sheet {
  position: relative;
  z-index: 1;
  padding: 26px 26px 22px;
  border: 1px solid var(--wm-line);
  background:
    linear-gradient(180deg, rgba(255, 253, 248, 0.92), rgba(250, 245, 235, 0.9)),
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 27px,
      rgba(79, 111, 82, 0.07) 27px,
      rgba(79, 111, 82, 0.07) 28px
    );
  box-shadow: 8px 10px 0 rgba(38, 48, 43, 0.055);
  transform: rotate(1.1deg);
}

.hero-sheet::after {
  position: absolute;
  top: -10px;
  left: 46px;
  width: 88px;
  height: 22px;
  background: rgba(216, 205, 187, 0.72);
  content: '';
  transform: rotate(-3deg);
}

.sheet-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--wm-line);
}

.sheet-title {
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: 22px;
  font-weight: 500;
}

.sheet-stamp {
  padding: 2px 6px;
  border: 1px solid rgba(180, 95, 63, 0.5);
  color: var(--wm-clay);
  font-size: 10px;
  letter-spacing: 0.08em;
  transform: rotate(-2deg);
}

.agent-list {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}

.agent-item {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px dashed rgba(216, 205, 187, 0.9);
  color: var(--wm-muted);
  font-size: 13px;
}

.agent-item--active {
  color: var(--wm-ink);
}

.agent-mark {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid var(--wm-line);
  border-radius: 50%;
  color: var(--wm-muted);
  font-family: var(--wm-serif);
  font-size: 10px;
}

.agent-item--active .agent-mark {
  border-color: var(--wm-pine);
  background: var(--wm-pine);
  color: #fffdf8;
}

.agent-name {
  font-weight: 500;
  letter-spacing: -0.01em;
}

.agent-role {
  color: var(--wm-muted);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.agent-item--active .agent-role {
  color: var(--wm-pine);
}

.sheet-note {
  margin: 18px 0 0;
  color: var(--wm-ink);
  font-family: var(--wm-serif);
  font-size: 16px;
  line-height: 1.6;
}

.sheet-rule {
  height: 1px;
  margin: 16px 0;
  background: var(--wm-line);
}

.sheet-foot {
  margin: 0;
  color: var(--wm-muted);
  font-size: 12px;
  line-height: 1.7;
}

@media (max-width: 860px) {
  .home-hero {
    display: block;
    min-height: 0;
    padding: 64px 20px 40px;
  }

  h1 {
    font-size: clamp(38px, 11vw, 56px);
  }

  .hero-sheet {
    margin-top: 40px;
    transform: none;
  }

  .hero-sheet::after {
    left: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .button {
    transition: none;
  }
}
</style>
