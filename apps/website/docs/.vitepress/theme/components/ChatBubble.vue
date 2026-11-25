<script setup lang="ts">
withDefaults(
  defineProps<{
    from: 'user' | 'agent'
  }>(),
  {
    from: 'agent',
  },
)
</script>

<template>
  <div class="chat-row" :class="`chat-row--${from}`">
    <div class="chat-bubble">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.chat-row {
  display: flex;
  margin: 10px 0;
}

.chat-row--user {
  justify-content: flex-end;
}

.chat-row--agent {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 86%;
  padding: 9px 12px;
  border-radius: 14px;
  background: #fffdf8;
  box-shadow: 0 1px 0 rgba(38, 48, 43, 0.06);
  color: var(--wm-ink);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.chat-row--user .chat-bubble {
  border-bottom-right-radius: 4px;
  background: #dfe8d7;
}

.chat-row--agent .chat-bubble {
  border-bottom-left-radius: 4px;
}
</style>
