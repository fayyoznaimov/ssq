<template>
	<html>
		<body>
			<NuxtLayout>
				<NuxtPage />
			</NuxtLayout>
		</body>
	</html>
</template>

<script lang="ts" setup>
import "moment/dist/locale/ru";
import "@vuepic/vue-datepicker/dist/main.css";

// The tab says «Сделки — Parisa CRM»; a page without a title of its own is «Parisa CRM»
const APP_TITLE = "Parisa CRM";
useHead({
    titleTemplate: (title) => (title && title !== APP_TITLE ? `${title} — ${APP_TITLE}` : APP_TITLE),
});
</script>

<style>
:root {
    --primary-200: 8, 176, 156;
    --primary-300: 6, 132, 116;
    --primary-400: 4, 87, 77;
    --primary-500: 2, 43, 38;
    --primary-600: 2, 39, 34;
    --primary-700: 2, 34, 30;
    --primary-800: 1, 30, 27;

    --slate-50: #f8fafc;
    --slate-100: #f1f5f9;
    --slate-200: #e2e8f0;
    --slate-300: #cbd5e1;
    --slate-400: #94a3b8;
    --slate-500: #64748b;
    --slate-600: #475569;
    --slate-700: #334155;
    --slate-800: #1e293b;
    --slate-900: #0f172a;

    /* FullCalendar */
    --fc-harness-bg-color: white;
    --fc-title-color: var(--slate-900);
    --fc-header-title: var(--slate-700);

    --fc-dot-event-hover: rgba(var(--primary-600), 0.2);

    --fc-small-font-size: .85em;
    --fc-page-bg-color: white;
    --fc-neutral-bg-color: var(--fc-harness-bg-color);
    --fc-neutral-text-color: #808080;
    --fc-border-color: var(--slate-100);

    --fc-button-text-color: rgb(var(--primary-600));
    --fc-button-bg-color: transparent;
    --fc-button-border-color: transparent;
    --fc-button-hover-bg-color: rgba(var(--primary-600), 0.2);
    --fc-button-hover-border-color: transparent;
    --fc-button-active-bg-color: rgba(var(--primary-600), 0.1);;
    --fc-button-active-border-color: transparent;

    --fc-event-resizer-thickness: 8px;
    --fc-event-resizer-dot-total-width: 8px;
    --fc-event-resizer-dot-border-width: 1px;

    --fc-highlight-color: rgba(var(--primary-600), 0.2);
    --fc-today-bg-color: rgba(var(--primary-600), 0.1);
    --fc-now-indicator-color: rgb(var(--primary-600));
}

.fc .fc-timegrid {
    --fc-today-bg-color:white;
}

.dp__theme_light {
    --dp-background-color: white;
    --dp-text-color: var(--slate-900);
    --dp-hover-color: rgba(var(--primary-600), 0.2);
    --dp-hover-text-color: var(--slate-900);
    --dp-hover-icon-color: var(--slate-700);
    --dp-primary-color: rgb(var(--primary-400));
    --dp-primary-disabled-color: rgba(var(--primary-600), 0.6)
    --dp-primary-text-color: white;
    --dp-secondary-color: var(--slate-300);
    --dp-border-color: var(--slate-100);
    --dp-menu-border-color: var(--slate-100);
    --dp-border-color-hover: #aaaeb7;
    --dp-disabled-color: #f6f6f6;
    --dp-scroll-bar-background: #f3f3f3;
    --dp-scroll-bar-color: #959595;
    --dp-success-color: #76d275;
    --dp-success-color-disabled: #a3d9b1;
    --dp-icon-color: #959595;
    --dp-disabled-color-text: #8e8e8e;
    --dp-highlight-color: rgb(25 118 210 / 10%);
    --dp-range-between-dates-background-color: var(--dp-hover-color, #f3f3f3);
    --dp-range-between-dates-text-color: var(--dp-hover-text-color, #212121);
    --dp-range-between-border-color: var(--dp-hover-color, #f3f3f3);
}

.dp__theme_dark {
    /* VueDatepicker */
    --dp-background-color: var(--slate-800);
    --dp-text-color: white;
    --dp-hover-color: rgb(var(--primary-300));
    --dp-hover-text-color: white;
    --dp-hover-icon-color: white;
    --dp-primary-color: rgb(var(--primary-400));
    --dp-primary-disabled-color: rgba(var(--primary-600), 0.6)
    --dp-primary-text-color: white;
    --dp-secondary-color: var(--slate-300);
    --dp-border-color: var(--slate-700);
    --dp-menu-border-color: var(--slate-700);
}

:root.dark {
    /* FullCalendar */
    --fc-harness-bg-color: var(--slate-800);
    --fc-border-color: var(--slate-700);
    --fc-today-bg-color: var(--slate-900);
    --fc-title-color: white;
    --fc-now-indicator-color: rgb(var(--primary-200));
    --fc-page-bg-color: rgb(var(--primary-200));
    --fc-button-text-color: rgb(var(--primary-200));
    --fc-button-active-bg-color: rgba(var(--primary-600), 0.4);;
    --fc-dot-event-hover: rgba(var(--primary-200), 0.1);
    --fc-header-title: var(--slate-200);
    --fc-highlight-color: rgba(var(--primary-400), 0.3);
}

:root.dark .fc .fc-timegrid {
    --fc-today-bg-color: var(--slate-800);
}

.fc-daygrid-dot-event.fc-event-mirror, .fc-daygrid-dot-event:hover {
    background: var(--fc-dot-event-hover);
}

.fc-view-harness {
    background: var(--fc-harness-bg-color);
    border-radius: 0.5rem;
}

.fc .fc-toolbar-title {
    font-size: 1rem;
    color: var(--fc-title-color);
}

.fc-timegrid-slot {
    font-size: 0.9rem;
    color: var(--fc-title-color);
}

.fc table th {
    font-weight: 400;
}

.fc table {
    border-radius: 0.5rem;
}

.fc-event-content {
    padding: 0 0.2rem;
    white-space: break-spaces;
}

.fc-daygrid-day-number {
    font-size: 0.9rem;
}

.fc .fc-col-header-cell {
    padding-top: 0.5rem;
    padding-bottom: 0.5rem;
    font-size: 1rem;
    color: var(--fc-header-title);
}

.fc .fc-header-toolbar {
    background: var(--fc-harness-bg-color);
    margin-bottom: 0.8rem !important;
    padding: 0.8rem;
    border-radius: 0.5rem;
    border: 1px solid var(--fc-border-color);
}

.fc .fc-timegrid-divider {
    display: none;
}

.fc .fc-button {
    font-size: 0.875rem;
    height: 2.5rem;
    padding: 0.5rem 1.25rem;
    line-height: 1.25rem;
    border-radius: 0.375rem;
    transition: background 200ms ease-in-out;
}

.fc .fc-button:not(:disabled).fc-button-active:focus, .fc .fc-button:not(:disabled):active:focus {
    box-shadow: none;
    outline: none;
}

.fc .fc-button-primary:focus {
    box-shadow: none;
    outline: none;
}

.fc .fc-button:focus-visible {
    outline: 2px dashed var(--slate-200);
}

.fc .fc-button .fc-icon {
    font-size: 1.25rem;
}

.fc-theme-standard .fc-scrollgrid {
    border: none;
}

.fc .fc-scroller {
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.fc .fc-scroller::-webkit-scrollbar {
    display: none;

}

.fc-event-overdue {
    @apply !bg-red-800 !border-red-800 text-white hover:!bg-red-900;
    --fc-page-bg-color: rgb(153, 27, 27);
}

.fc-event-future {
    @apply bg-primary-400 hover:bg-primary-500 text-white hover:dark:bg-primary-300;
}
</style>
