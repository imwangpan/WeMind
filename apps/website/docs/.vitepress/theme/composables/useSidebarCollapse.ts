import { ref } from 'vue'

const storageKey = 'wemind-sidebar-collapsed'
const collapsed = ref(false)

function applyCollapsed(value: boolean) {
  collapsed.value = value
  if (typeof document === 'undefined') return

  if (value) {
    document.documentElement.setAttribute('data-sidebar-collapsed', 'true')
  } else {
    document.documentElement.removeAttribute('data-sidebar-collapsed')
  }
}

export function useSidebarCollapse() {
  function syncFromDocument() {
    if (typeof document === 'undefined') return
    collapsed.value = document.documentElement.dataset.sidebarCollapsed === 'true'
  }

  function setCollapsed(value: boolean) {
    applyCollapsed(value)
    try {
      localStorage.setItem(storageKey, value ? '1' : '0')
    } catch {
      // Storage can be unavailable in private mode; the current page still works.
    }
  }

  return {
    collapsed,
    syncFromDocument,
    setCollapsed,
    toggle: () => setCollapsed(!collapsed.value),
  }
}
