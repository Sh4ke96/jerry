// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialog } from '../src/components/ConfirmDialog';

describe('ConfirmDialog', () => {
  const mounted: Array<ReturnType<typeof mount>> = [];
  const mountDialog = async () => {
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { title: 'Approve JRY-0007 plan v2', expected: 'JRY-0007', confirmLabel: 'Approve plan' },
      slots: { default: () => 'Scope: src/**' },
    });
    mounted.push(wrapper);
    await flushPromises();
    // The dialog opens in a portal on <body>.
    return { wrapper, dialog: new DOMWrapper(document.body).get('[role="alertdialog"]') };
  };
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
  });

  it('keeps the confirm button disabled until the exact text is typed', async () => {
    const { wrapper, dialog } = await mountDialog();
    const confirm = dialog.get('button[type="submit"]');
    expect(confirm.attributes('disabled')).toBeDefined();

    await dialog.get('input').setValue('JRY-0008');
    expect(confirm.attributes('disabled')).toBeDefined();
    await dialog.get('form').trigger('submit');
    expect(wrapper.emitted('confirm')).toBeUndefined();

    await dialog.get('input').setValue('JRY-0007');
    expect(confirm.attributes('disabled')).toBeUndefined();
    await dialog.get('form').trigger('submit');
    expect(wrapper.emitted('confirm')).toEqual([['JRY-0007', '']]);
  });

  it('cancels with the button or Escape', async () => {
    const first = await mountDialog();
    await first.dialog.get('button[type="button"]').trigger('click');
    await flushPromises();
    expect(first.wrapper.emitted('cancel')).toHaveLength(1);
    for (const wrapper of mounted.splice(0)) wrapper.unmount();

    const second = await mountDialog();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(second.wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('shows the decision details passed in', async () => {
    const { dialog } = await mountDialog();
    expect(dialog.text()).toContain('Scope: src/**');
  });
});
