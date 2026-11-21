// https://github.com/donmbelembe/vue-dragscroll

import type { DirectiveBinding, VNode } from 'vue';

function emitEvent(vnode: any, eventName: string, eventDetail?: any) {
    // Vue 3
    // If vnode is a Vue component instance, use $emit. Otherwise use a native HTML event.
    if (vnode.componentInstance) {
        vnode.componentInstance.$emit(eventName, eventDetail);
    } else {
        const event = new window.CustomEvent(eventName, { detail: eventDetail });
        vnode.el.dispatchEvent(event);
    }
}

const init = function(el: Element, binding: DirectiveBinding, vnode: VNode) {
    // Default parameters
    const target = el as any; // the element to apply the dragscroll on
    const summary  = target.querySelector('summary');
    const content = target.querySelector('.content');
    let animation = null;
    let isClosing = false;
    let isExpanding = false;

    function shrink() {
        isClosing = true;

        const startHeight = `${target.offsetHeight}px`;
        const endHeight = `${summary.offsetHeight}px`;
    
        if (animation) {
            animation.cancel();
        }
    
        animation = target.animate({ height: [startHeight, endHeight] }, { duration: 300, easing: 'ease-out' });
    
        animation.onfinish = () => onAnimationFinish(false);
        // If the animation is cancelled, isClosing variable is set to false
        animation.oncancel = () => isClosing = false;
    }

    function onAnimationFinish(open: boolean) {
        target.open = open;
        animation = null;
        isClosing = false;
        isExpanding = false;
        target.style.height = target.style.overflow = '';
    }

    function open() {
        target.style.height = `${target.offsetHeight}px`;
        target.open = true;
        window.requestAnimationFrame(expand);
    }

    function expand() {
        isExpanding = true;
        const startHeight = `${target.offsetHeight}px`;
        const endHeight = `${summary.offsetHeight + content.offsetHeight}px`;
        
        if (animation) {
            animation.cancel();
        }
        animation = target.animate({
            height: [startHeight, endHeight]
        }, {
            duration: 300,
            easing: 'ease-out'
        });
        animation.onfinish = () => onAnimationFinish(true);
        animation.oncancel = () => isExpanding = false;
    }

    const reset = function() {
        target.clck = function(e: any) {
            e.preventDefault();
            target.style.overflow = 'hidden';
            if (isClosing || !target.open) {
                open();
            } else if (isExpanding || target.open) {
                shrink();
            }
        };

        summary.addEventListener('click', target.clck);
    };

    if (document.readyState === 'complete') reset();
};

const destroy = (el: any) => {
    const target = el;
    const summary  = target.querySelector('summary');
    summary.removeEventListener('click', target.clck);
};

const animatedDetails = {
    mounted: (el: Element, binding: DirectiveBinding, vnode: VNode) => init(el, binding, vnode),
    updated: (el: Element, binding: DirectiveBinding, vnode: VNode) => {
        // update the component only if the parameters change
        if (JSON.stringify(binding.value) !== JSON.stringify(binding.oldValue)) {
            init(el, binding, vnode);
        }
    },
    unmounted: (el: Element) => destroy(el),
};

export default defineNuxtPlugin((nuxtApp) => {
    nuxtApp.vueApp.directive('animated-details', animatedDetails);
});
