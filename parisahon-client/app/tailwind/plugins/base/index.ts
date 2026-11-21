import plugin from 'tailwindcss/plugin';

export const base = plugin(({ addBase }) =>
    addBase({
        '.dark': { colorScheme: 'dark' },
        'details > summary': { listStyle: 'none' },
        'details > summary::-webkit-details-marker': { display: 'none' },
        '.no-scrollbar': { 
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
        },
        '.no-scrollbar::-webkit-scrollbar': {
            display: 'none',
        }
    }),
);
