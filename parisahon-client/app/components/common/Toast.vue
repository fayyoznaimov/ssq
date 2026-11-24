<template>
    <transition name="toast">
        <!-- the text wraps inside the toast (a long one ran past the screen) and there is always a cross -->
        <div
            v-if="show"
            class="fixed top-5 right-5 left-5 sm:left-auto z-[99999] mb-4 flex items-start gap-3 rounded-lg p-4 shadow-lg sm:w-full sm:max-w-sm bg-white text-muted-700 ring-1 ring-muted-200 dark:bg-muted-800 dark:text-muted-100 dark:ring-muted-700"
            :role="type === 'success' ? 'status' : 'alert'"
            @mouseenter="pause"
            @mouseleave="resume"
        >
            <div
                v-if="type === 'success'"
                class="inline-flex flex-shrink-0 justify-center items-center w-8 h-8 text-green-600 dark:text-green-100 bg-green-100 dark:bg-green-700 rounded-lg"
            >
                <Icon name="ph:check" class="w-5 h-5" />
                <span class="sr-only">Готово</span>
            </div>
            <div
                v-else
                class="inline-flex flex-shrink-0 justify-center items-center w-8 h-8 text-red-600 dark:text-red-100 bg-red-100 dark:bg-red-700 rounded-lg"
            >
                <Icon name="ph:warning-circle" class="w-5 h-5" />
                <span class="sr-only">Ошибка</span>
            </div>
            <div class="min-w-0 flex-1 self-center text-sm font-normal break-words [overflow-wrap:anywhere] line-clamp-6">
                {{ message }}
            </div>
            <button
                class="-my-1 -me-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-400 hover:bg-muted-100 hover:text-muted-700 focus:ring-2 focus:ring-muted-300 dark:hover:bg-muted-700 dark:hover:text-white"
                type="button"
                title="Закрыть"
                @click="close"
            >
                <span class="sr-only">Закрыть</span>
                <Icon name="ph:x" class="w-4 h-4" />
            </button>
        </div>
    </transition>
</template>

<script lang="ts" setup>
import {type ToastOptions} from '~/composables/useToast';
import {bus} from '~/constants';

const props = defineProps<{id: string}>();

const show = ref(false);
const message = ref('');
const type = ref('success');

// a toast closes itself after its timeout; the mouse over it holds it open
let timer: ReturnType<typeof setTimeout> | undefined;
let left = 0;
let startedAt = 0;

function startTimer(ms: number) {
    clearTimeout(timer);
    if (!ms) return;
    left = ms;
    startedAt = Date.now();
    timer = setTimeout(() => {
        show.value = false;
    }, ms);
}

function pause() {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    left = Math.max(left - (Date.now() - startedAt), 1500);
}

function resume() {
    if (show.value && left && !timer) startTimer(left);
}

function close() {
    clearTimeout(timer);
    timer = undefined;
    show.value = false;
}

function onOpen({id, message: msg, timeout, type: t}: ToastOptions & { id: string }) {
    if (id !== props.id) {
        return;
    }
    show.value = true;
    message.value = msg;
    type.value = t || 'success';
    // an error is read longer than «Сохранено»
    startTimer(timeout ? (type.value === 'error' ? Math.max(timeout, 5000) : timeout) : 0);
}

function onClose({id}: { id: string }) {
    if (id === props.id) {
        close();
    }
}

bus.on('toast.open', onOpen);
bus.on('toast.close', onClose);

// every layout has its own toast: the one of a layout that is gone stops listening
onBeforeUnmount(() => {
    clearTimeout(timer);
    bus.off('toast.open', onOpen);
    bus.off('toast.close', onClose);
});
</script>

<style lang="scss" scoped>
.toast-enter-from {
    transform: translateX(200px);
    opacity: 0;
}

.toast-enter-to {
    transform: translateX(0);
}

.toast-enter-active {
    transition: all 0.4s ease;
}
</style>
