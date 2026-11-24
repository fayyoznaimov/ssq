<template>
    <BaseCard
        rounded="sm"
        class="border-2 !py-2 !px-2"
    >
        <!-- Hidden audio element -->
        <audio
            ref="audioPlayer"
            :src="audioSrc"
            class="hidden"
        />

        <div class="flex w-full items-center gap-4">
            <!-- Play/Pause Button (replaces the avatar) -->
            <button
                class="focus:outline-none text-gray-600"
                @click="togglePlay"
            >
                <!-- Show pause icon if playing, otherwise play icon -->
                <Icon
                    v-if="!isPlaying"
                    name="ph:play"
                    class="size-6"
                />
                <Icon
                    v-else
                    name="ph:pause"
                    class="size-6"
                />
            </button>

            <div class="flex-grow">
                <!-- Slider (replaces the heading) -->
                <input
                    v-model="sliderValue"
                    type="range"
                    min="0"
                    max="100"
                    class="flex-1 h-1 text-muted-300 rounded-lg appearance-none cursor-pointer w-full"
                    @input="onSliderInput"
                >

                <!-- Current Time / Total Duration (replaces the subtitle) -->
                <div
                    class="text-xs text-gray-500 mt-2 flex items-center justify-between"
                >
                    <span>{{ formatTime(currentTime) }}</span>
                    <span>{{ formatTime(duration) }}</span>
                </div>
            </div>
        </div>
    </BaseCard>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";

interface Props {
    src: string;
    // the length known before the file is loaded (a call recording: milliseconds); the player showed 0:00 until play
    durationMs?: number | null;
}
const props = defineProps<Props>();

const baseUrl = useApiUrl();

const audioSrc = computed(() => `${baseUrl}/uploads/${props.src}`);

const audioPlayer = ref<HTMLAudioElement | null>(null);

// Is audio currently playing?
const isPlaying = ref(false);

// Slider progress (0–100)
const sliderValue = ref(0);

// Current playback time and total duration (in seconds)
const currentTime = ref(0);
const duration = ref(props.durationMs ? props.durationMs / 1000 : 0);

// Format time in M:SS
function formatTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0");
    return `${m}:${s}`;
}

// Toggle play/pause
function togglePlay() {
    if (!audioPlayer.value) return;
    isPlaying.value ? audioPlayer.value.pause() : audioPlayer.value.play();
}

// Seek when slider changes
function onSliderInput() {
    if (audioPlayer.value && audioPlayer.value.duration) {
        audioPlayer.value.currentTime =
            (sliderValue.value / 100) * audioPlayer.value.duration;
    }
}

// Update slider & currentTime
function onTimeUpdate() {
    if (!audioPlayer.value || !audioPlayer.value.duration) return;
    currentTime.value = audioPlayer.value.currentTime;
    sliderValue.value =
        (audioPlayer.value.currentTime / audioPlayer.value.duration) * 100;
}

// Reset when audio ends
function onEnded() {
    isPlaying.value = false;
    sliderValue.value = 0;
    currentTime.value = 0;
}

// Load total duration
function onLoadedMetadata() {
    if (audioPlayer.value && Number.isFinite(audioPlayer.value.duration) && audioPlayer.value.duration > 0) {
        duration.value = audioPlayer.value.duration;
    }
}

onMounted(() => {
    if (!audioPlayer.value) return;

    audioPlayer.value.addEventListener("loadedmetadata", onLoadedMetadata);
    audioPlayer.value.addEventListener("timeupdate", onTimeUpdate);
    audioPlayer.value.addEventListener("ended", onEnded);

    audioPlayer.value.addEventListener("play", () => (isPlaying.value = true));
    audioPlayer.value.addEventListener(
        "pause",
        () => (isPlaying.value = false)
    );
});
</script>
