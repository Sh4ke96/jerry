// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { Loading, Spinner } from '../src/components/ui/spinner';

describe('Spinner and Loading', () => {
  it('announces itself and spins only when motion is allowed', () => {
    const spinner = mount(Spinner, { props: { label: 'Saving…' } });
    const icon = spinner.get('[data-slot="spinner"]');
    expect(icon.attributes('role')).toBe('status');
    expect(icon.attributes('aria-label')).toBe('Saving…');
    expect(icon.classes()).toContain('motion-safe:animate-spin');
    expect(icon.classes()).not.toContain('animate-spin');
  });

  it('shows the spinner with the text of what loads', () => {
    const plain = mount(Loading);
    expect(plain.text()).toBe('Loading…');
    expect(plain.find('[data-slot="spinner"]').exists()).toBe(true);
    const history = mount(Loading, { props: { text: 'Loading history…', class: 'text-xs' } });
    expect(history.text()).toBe('Loading history…');
    expect(history.classes()).toContain('text-xs');
    expect(history.get('[data-slot="spinner"]').attributes('aria-label')).toBe('Loading history…');
  });
});
