<template>
    <Icon
        :name="icon.name"
        :class="[
          icon.color,
          props.class,
        ]"
    />
</template>
<script lang="ts" setup>
const props = withDefaults(defineProps<{
  fileName: string;
  class?: string | string[];
}>(), {
  class: 'w-5 h-5'
});

const extIconMap: Record<string, {name: string, color: string}> = {
  pdf: {
    name: 'ph:file-pdf',
    color: 'text-red-500',
  },
  doc: {
    name: 'ph:file-doc',
    color: 'text-blue-500'
  },
  docx: {
    name: 'ph:file-doc',
    color: 'text-blue-500'
  },
  xls: {
    name: 'ph:file-xls',
    color: 'text-green-500',
  },
  xlsx: {
    name: 'ph:file-xls',
    color: 'text-green-500',
  },
  ppt: {
    name: 'ph:file-ppt',
    color: 'text-yellow-500',
  },
  pptx: {
    name: 'ph:file-ppt',
    color: 'text-yellow-500',
  },
  jpg: {
    name: 'ph:image-square',
    color: 'text-gray-500',
  },
  jpeg: {
    name: 'ph:image-square',
    color: 'text-gray-500',
  },
  png: {
    name: 'ph:image-square',
    color: 'text-gray-500',
  },
  gif: {
    name: 'ph:image-square',
    color: 'text-gray-500',
  },
  svg: {
    name: 'ph:file-svg',
    color: 'text-gray-500',
  },
}

const icon = extIconMap[props.fileName.split('.').pop()?.toLowerCase() || ''] || {name: 'lucide:file', color: 'text-gray-500'}

</script>