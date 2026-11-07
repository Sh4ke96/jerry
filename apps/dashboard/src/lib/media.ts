import { onScopeDispose, ref, type Ref } from 'vue';

/** Whether a media query matches, kept live; false where the browser cannot tell. */
export function useMediaQuery(query: string): Ref<boolean> {
  const matches = ref(false);
  let list: MediaQueryList | null = null;
  try {
    list = window.matchMedia(query);
    matches.value = list.matches;
  } catch {
    return matches;
  }
  const update = (event: MediaQueryListEvent): void => {
    matches.value = event.matches;
  };
  list.addEventListener('change', update);
  onScopeDispose(() => list?.removeEventListener('change', update));
  return matches;
}
