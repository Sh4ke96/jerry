// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from '../src/components/ConfirmDialog';

describe('ConfirmDialog', () => {
  const mountDialog = () =>
    mount(ConfirmDialog, {
      props: { title: 'Approve JRY-0007 plan v2', expected: 'JRY-0007', confirmLabel: 'Approve plan' },
      slots: { default: () => 'Scope: src/**' },
    });

  it('keeps the confirm button disabled until the exact text is typed', async () => {
    const wrapper = mountDialog();
    const confirm = wrapper.get('button[type="submit"]');
    expect(confirm.attributes('disabled')).toBeDefined();

    await wrapper.get('input').setValue('JRY-0008');
    expect(confirm.attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('confirm')).toBeUndefined();

    await wrapper.get('input').setValue('JRY-0007');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('confirm')).toEqual([['JRY-0007', '']]);
  });

  it('cancels with the button or Escape', async () => {
    const wrapper = mountDialog();
    await wrapper.get('button[type="button"]').trigger('click');
    await wrapper.get('form').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('cancel')).toHaveLength(2);
  });

  it('shows the decision details passed in', () => {
    expect(mountDialog().text()).toContain('Scope: src/**');
  });
});
