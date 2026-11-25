/// <reference types="vite/client" />

declare module '*.po' {
  export const messages: Record<string, string>
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
