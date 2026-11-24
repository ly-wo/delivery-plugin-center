<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
const props = defineProps<{ label: string }>();
const emit = defineEmits<{ cancel: [] }>();
const dialog = ref<HTMLDialogElement>();
let opener: HTMLElement | null = null;
function focusTitle() { dialog.value?.querySelector<HTMLElement>('[data-dialog-title]')?.focus(); }
onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.value?.showModal();
  focusTitle();
});
watch(() => props.label, () => void nextTick(focusTitle));
onBeforeUnmount(() => {
  dialog.value?.close();
  if (opener?.isConnected) opener.focus();
  else document.querySelector<HTMLElement>('[data-market-focus]')?.focus();
});
</script>
<template>
  <dialog ref="dialog" class="dialog" :aria-label="label" @cancel.prevent="emit('cancel')">
    <slot />
  </dialog>
</template>
