// Sidebar, ported to TSX from shadcn-vue 2.9.0, style "new-york-v4"
// (https://github.com/unovue/shadcn-vue, MIT License, Copyright (c) 2023 unovue).
// Simplified: the parts the dashboard needs. The open state is kept in localStorage instead of a
// cookie, and the widths come from styles.css instead of an inline style.
import { PanelLeft } from '@lucide/vue';
import { cva, type VariantProps } from 'class-variance-authority';
import { createContext, Primitive } from 'reka-ui';
import { computed, defineComponent, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue';
import { slotted, type ElementProps } from '../../../lib/component';
import { useMediaQuery } from '../../../lib/media';
import { cn } from '../../../lib/utils';
import { Button } from '../button';
import { Separator } from '../separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip';

const STORAGE_KEY = 'jerry.sidebar';
const KEYBOARD_SHORTCUT = 'b';
const MOBILE_BREAKPOINT = 768;

interface SidebarContext {
  state: ComputedRef<'expanded' | 'collapsed'>;
  open: Ref<boolean>;
  setOpen: (value: boolean) => void;
  isMobile: Ref<boolean>;
  openMobile: Ref<boolean>;
  setOpenMobile: (value: boolean) => void;
  toggleSidebar: () => void;
}

export const [useSidebar, provideSidebarContext] = createContext<SidebarContext>('Sidebar');

function storedOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export const SidebarProvider = defineComponent(
  (props: ElementProps, { slots }) => {
    const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const open = ref(storedOpen());
    const openMobile = ref(false);
    const setOpen = (value: boolean): void => {
      open.value = value;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(value));
      } catch {
        // storage unavailable: the choice lasts for this page only
      }
    };
    const setOpenMobile = (value: boolean): void => {
      openMobile.value = value;
    };
    const toggleSidebar = (): void => (isMobile.value ? setOpenMobile(!openMobile.value) : setOpen(!open.value));
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    onMounted(() => window.addEventListener('keydown', onKeydown));
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));
    const state = computed(() => (open.value ? 'expanded' : 'collapsed'));
    provideSidebarContext({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar });

    return () => (
      <TooltipProvider delayDuration={0}>
        <div data-slot="sidebar-wrapper" class={cn('group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full', props.class)}>
          {slots.default?.()}
        </div>
      </TooltipProvider>
    );
  },
  { name: 'SidebarProvider', props: ['class'] },
);

export interface SidebarProps extends ElementProps {
  side?: 'left' | 'right';
  variant?: 'sidebar' | 'floating' | 'inset';
  collapsible?: 'offcanvas' | 'icon' | 'none';
}

export const Sidebar = defineComponent(
  (props: SidebarProps, { slots, attrs }) => {
    const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
    return () => {
      const side = props.side ?? 'left';
      const variant = props.variant ?? 'sidebar';
      const collapsible = props.collapsible ?? 'offcanvas';
      if (collapsible === 'none') {
        return (
          <div data-slot="sidebar" class={cn('bg-sidebar text-sidebar-foreground flex w-(--sidebar-width) flex-col', props.class)} {...attrs}>
            {slots.default?.()}
          </div>
        );
      }
      if (isMobile.value) {
        return (
          <Sheet open={openMobile.value} onUpdate:open={setOpenMobile}>
            <SheetContent data-sidebar="sidebar" data-slot="sidebar" data-mobile="true" side={side} class="bg-sidebar text-sidebar-foreground w-(--sidebar-width) p-0 [&>button]:hidden">
              <SheetHeader class="sr-only">
                <SheetTitle>Sidebar</SheetTitle>
                <SheetDescription>Displays the mobile sidebar.</SheetDescription>
              </SheetHeader>
              <div class="flex h-full w-full flex-col">{slots.default?.()}</div>
            </SheetContent>
          </Sheet>
        );
      }
      return (
        <div class="group peer text-sidebar-foreground hidden md:block" data-slot="sidebar" data-state={state.value} data-collapsible={state.value === 'collapsed' ? collapsible : ''} data-variant={variant} data-side={side}>
          <div
            class={cn(
              'relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear',
              'group-data-[collapsible=offcanvas]:w-0',
              'group-data-[side=right]:rotate-180',
              variant === 'floating' || variant === 'inset' ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]' : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
            )}
          />
          <div
            class={cn(
              'fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear md:flex',
              side === 'left' ? 'left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]' : 'right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)]',
              variant === 'floating' || variant === 'inset' ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]' : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
              props.class,
            )}
            {...attrs}
          >
            <div data-sidebar="sidebar" class="bg-sidebar group-data-[variant=floating]:border-sidebar-border flex h-full w-full flex-col group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:shadow-sm">
              {slots.default?.()}
            </div>
          </div>
        </div>
      );
    };
  },
  { name: 'Sidebar', props: ['side', 'variant', 'collapsible', 'class'], inheritAttrs: false },
);

export const SidebarTrigger = defineComponent(
  (props: ElementProps) => {
    const { toggleSidebar } = useSidebar();
    return () => (
      <Button data-sidebar="trigger" data-slot="sidebar-trigger" variant="ghost" size="icon" class={cn('h-7 w-7', props.class)} onClick={toggleSidebar}>
        <PanelLeft />
        <span class="sr-only">Toggle Sidebar</span>
      </Button>
    );
  },
  { name: 'SidebarTrigger', props: ['class'] },
);

export const SidebarRail = defineComponent(
  (props: ElementProps) => {
    const { toggleSidebar } = useSidebar();
    return () => (
      <button
        data-sidebar="rail"
        data-slot="sidebar-rail"
        aria-label="Toggle Sidebar"
        tabindex={-1}
        title="Toggle Sidebar"
        class={cn(
          'hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 sm:flex',
          'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
          '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
          'hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full',
          '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
          '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
          props.class,
        )}
        onClick={toggleSidebar}
      />
    );
  },
  { name: 'SidebarRail', props: ['class'] },
);

export const SidebarInset = slotted(
  'SidebarInset',
  'main',
  'sidebar-inset',
  cn('bg-background relative flex w-full flex-1 flex-col', 'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2'),
);

export const SidebarHeader = slotted('SidebarHeader', 'div', 'sidebar-header', 'flex flex-col gap-2 p-2', { 'data-sidebar': 'header' });

export const SidebarFooter = slotted('SidebarFooter', 'div', 'sidebar-footer', 'flex flex-col gap-2 p-2', { 'data-sidebar': 'footer' });

export const SidebarSeparator = defineComponent((props: ElementProps) => () => <Separator data-slot="sidebar-separator" data-sidebar="separator" class={cn('bg-sidebar-border mx-2 w-auto', props.class)} />, { name: 'SidebarSeparator', props: ['class'] });

export const SidebarContent = slotted('SidebarContent', 'div', 'sidebar-content', 'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden', { 'data-sidebar': 'content' });

export const SidebarGroup = slotted('SidebarGroup', 'div', 'sidebar-group', 'relative flex w-full min-w-0 flex-col p-2', { 'data-sidebar': 'group' });

export const SidebarGroupLabel = slotted(
  'SidebarGroupLabel',
  'div',
  'sidebar-group-label',
  cn(
    'text-sidebar-foreground/70 ring-sidebar-ring flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
    'group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:select-none group-data-[collapsible=icon]:opacity-0',
  ),
  { 'data-sidebar': 'group-label' },
);

export const SidebarGroupContent = slotted('SidebarGroupContent', 'div', 'sidebar-group-content', 'w-full text-sm', { 'data-sidebar': 'group-content' });

export const SidebarMenu = slotted('SidebarMenu', 'ul', 'sidebar-menu', 'flex w-full min-w-0 flex-col gap-1', { 'data-sidebar': 'menu' });

export const SidebarMenuItem = slotted('SidebarMenuItem', 'li', 'sidebar-menu-item', 'group/menu-item relative', { 'data-sidebar': 'menu-item' });

export const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline: 'bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type SidebarMenuButtonVariants = VariantProps<typeof sidebarMenuButtonVariants>;

export interface SidebarMenuButtonProps extends ElementProps {
  variant?: SidebarMenuButtonVariants['variant'];
  size?: SidebarMenuButtonVariants['size'];
  isActive?: boolean;
  /** Shown next to the button while the sidebar is collapsed to icons. */
  tooltip?: string;
  as?: string;
  asChild?: boolean;
}

export const SidebarMenuButton = defineComponent(
  (props: SidebarMenuButtonProps, { slots, attrs }) => {
    const { isMobile, state } = useSidebar();
    return () => {
      const size = props.size ?? 'default';
      const button = (
        <Primitive
          data-slot="sidebar-menu-button"
          data-sidebar="menu-button"
          data-size={size}
          data-active={props.isActive}
          as={props.as ?? 'button'}
          asChild={props.asChild}
          {...attrs}
          class={cn(sidebarMenuButtonVariants({ variant: props.variant, size }), props.class)}
        >
          {slots.default?.()}
        </Primitive>
      );
      if (props.tooltip === undefined) return button;
      return (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right" align="center" hidden={state.value !== 'collapsed' || isMobile.value}>
            {props.tooltip}
          </TooltipContent>
        </Tooltip>
      );
    };
  },
  { name: 'SidebarMenuButton', props: ['variant', 'size', 'isActive', 'tooltip', 'as', 'asChild', 'class'], inheritAttrs: false },
);

export const SidebarMenuBadge = slotted(
  'SidebarMenuBadge',
  'div',
  'sidebar-menu-badge',
  cn(
    'text-sidebar-foreground pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium tabular-nums select-none',
    'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
    'peer-data-[size=sm]/menu-button:top-1',
    'peer-data-[size=default]/menu-button:top-1.5',
    'peer-data-[size=lg]/menu-button:top-2.5',
    'group-data-[collapsible=icon]:hidden',
  ),
  { 'data-sidebar': 'menu-badge' },
);
