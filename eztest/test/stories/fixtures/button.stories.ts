/**
 * A framework-neutral CSF story file for the harness tests: the component is a
 * plain function returning a DOM node, so the built-in DOM renderer mounts it
 * (no React/Vue needed). The shape (default export title + args, named story
 * exports with their own args and an optional play()) matches Storybook CSF.
 */
export interface ButtonArgs {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}

export function Button(args: ButtonArgs): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = args.label;
  b.className = `btn btn-${args.variant ?? 'primary'}`;
  b.setAttribute('data-variant', args.variant ?? 'primary');
  if (args.disabled) b.disabled = true;
  // An accessible name comes from the text; a plain button has no a11y violations.
  return b;
}

export default {
  title: 'Example/Button',
  component: Button,
  args: { label: 'Button', variant: 'primary' },
};

export const Primary = {
  args: { label: 'Click me', variant: 'primary' },
};

export const Secondary = {
  args: { label: 'Cancel', variant: 'secondary' },
};

export const Danger = {
  render: (args: ButtonArgs) => Button({ ...args, variant: 'danger' }),
  args: { label: 'Delete' },
};

/** A story whose button is missing an accessible name, so the a11y lens flags it. */
export const Inaccessible = {
  render: () => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    return b; // no text, no aria-label
  },
};
