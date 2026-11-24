<template>
    <!--
        A call recording or a voice message (the history). The native <audio preload="none"> showed
        «0:00 / 0:00» until it was played, so a call looked empty: the length comes from the data
        (event.duration, ms) at once, the file is asked only for its metadata, and a file that is gone
        says «запись недоступна» instead of a dead player.
    -->
    <span v-if="!src || failed" class="inline-flex items-center gap-1 text-[13px] text-muted-500 dark:text-muted-400">
        <Icon name="ph:speaker-simple-slash" class="size-4" />запись недоступна<template v-if="totalText"> · {{ totalText }}</template>
    </span>
    <span v-else class="inline-flex w-full max-w-xs items-center gap-2 rounded-full bg-muted-100 py-1 pe-3 ps-1 dark:bg-muted-700/70">
        <button
            type="button"
            class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-500 text-white hover:bg-primary-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
            :title="playing ? 'Пауза' : 'Слушать'"
            :aria-label="playing ? 'Пауза' : 'Слушать'"
            @click="toggle"
        >
            <Icon :name="playing ? 'ph:pause-fill' : 'ph:play-fill'" class="size-4" />
        </button>
        <input
            type="range"
            min="0"
            :max="total || 0"
            step="0.1"
            :value="current"
            class="h-1 min-w-0 flex-1 cursor-pointer accent-primary-500"
            aria-label="Позиция записи"
            @input="seek"
        >
        <span class="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-600 dark:text-muted-300">{{ clockOf(current) }} / {{ totalText || '—' }}</span>
        <audio
            ref="audio"
            :src="src"
            preload="metadata"
            class="hidden"
            @loadedmetadata="onMeta"
            @durationchange="onMeta"
            @timeupdate="onTime"
            @play="playing = true"
            @pause="playing = false"
            @ended="onEnded"
            @error="failed = true"
        />
    </span>
</template>

<script setup lang="ts">
const props = defineProps<{
    // the full address of the file (uploadUrl(path)); empty: nothing to play
    src?: string | null;
    // the length known from the data, milliseconds (event.duration of a call)
    durationMs?: number | string | null;
}>();

const audio = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const failed = ref(false);
const current = ref(0);
const fileSeconds = ref(0);

const total = computed(() => {
    if (fileSeconds.value > 0 && Number.isFinite(fileSeconds.value)) return fileSeconds.value;
    const ms = Number(props.durationMs ?? 0);
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
});
const totalText = computed(() => (total.value > 0 ? clockOf(total.value) : ''));

watch(() => props.src, () => {
    failed.value = false;
    playing.value = false;
    current.value = 0;
    fileSeconds.value = 0;
});

function clockOf(seconds: number): string {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

function onMeta() {
    const d = audio.value?.duration ?? 0;
    if (Number.isFinite(d) && d > 0) fileSeconds.value = d;
}

function onTime() {
    current.value = audio.value?.currentTime ?? 0;
}

function onEnded() {
    playing.value = false;
    current.value = 0;
}

async function toggle() {
    const el = audio.value;
    if (!el) return;
    if (!el.paused) {
        el.pause();
        return;
    }
    // one recording at a time in the history
    document.querySelectorAll('audio').forEach((other) => {
        if (other !== el && !other.paused) other.pause();
    });
    try {
        await el.play();
    } catch (error: any) {
        // the user stopped it (AbortError) is fine; a missing or unplayable file is not
        if (error?.name !== 'AbortError') failed.value = true;
    }
}

function seek(e: Event) {
    const el = audio.value;
    const value = Number((e.target as HTMLInputElement).value);
    if (!el || !Number.isFinite(value)) return;
    el.currentTime = value;
    current.value = value;
}
</script>
