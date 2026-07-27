// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
	site: 'https://fancyboi999-bot.github.io/open-tag',
	base: process.env.ASTRO_BASE,
	integrations: [sitemap()],
});
