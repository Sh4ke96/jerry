import { defineComponent } from 'vue';
import { classProp, cn } from '../lib/utils';

/**
 * The JERRY logo: the "J" of Geist Bold (SIL Open Font License 1.1) on a rounded square, the same
 * drawing as public/icons/icon.svg and the JERRY Desktop icon. Decorative: the name is next to it.
 */
export const Logo = defineComponent({
  name: 'Logo',
  props: { class: classProp },
  setup(props) {
    return () => (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" aria-hidden="true" class={cn('shrink-0 rounded-[22%] dark:ring-1 dark:ring-white/15', props.class)}>
        <rect width="1024" height="1024" rx="225" ry="225" fill="#09090b" />
        <path
          d="M503.8 812L503.8 812Q435.2 812 387.7 783.1Q340.2 754.1 315 704.1Q289.8 654.1 289 589.7L289 589.7L415.4 583.9Q416.2 646.7 439.4 676.5Q462.5 706.2 503.8 706.2L503.8 706.2Q546 706.2 569.1 677.3Q592.3 648.4 592.3 588L592.3 588L592.3 212L717.9 212L717.9 588Q717.9 656.6 691 707Q664.2 757.5 616.2 784.7Q568.3 812 503.8 812"
          fill="#fafafa"
        />
      </svg>
    );
  },
});
