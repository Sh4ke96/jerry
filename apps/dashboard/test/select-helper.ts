import { DOMWrapper, flushPromises } from '@vue/test-utils';

/** Opens a shadcn Select from its trigger (reka-ui opens it on Enter) and returns its options, rendered in a portal on <body>. */
export async function openSelect(trigger: Pick<DOMWrapper<Element>, 'trigger'>): Promise<DOMWrapper<Element>[]> {
  await trigger.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  return new DOMWrapper(document.body).findAll('[role="option"]');
}

/** Chooses the option with this text from an open Select (reka-ui selects on Enter). */
export async function chooseOption(options: DOMWrapper<Element>[], text: string): Promise<void> {
  const option = options.find((candidate) => candidate.text() === text);
  if (option === undefined) throw new Error(`No option "${text}" in ${options.map((candidate) => candidate.text()).join(', ')}`);
  await option.trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

/** Opens a Select and chooses the option with this text. */
export async function pickOption(trigger: Pick<DOMWrapper<Element>, 'trigger'>, text: string): Promise<void> {
  await chooseOption(await openSelect(trigger), text);
}
