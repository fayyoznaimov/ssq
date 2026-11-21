<script setup lang="ts">
const props = defineProps<{
  open: boolean;
}>();

const emits = defineEmits<{
  (e: 'change', value: boolean): void;
}>();

watch(props, () => {
    emits('change', props.open);
});
</script>