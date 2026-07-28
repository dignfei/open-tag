// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
	site: 'https://docs.getopentag.com',
	base: process.env.ASTRO_BASE,
	integrations: [sitemap()],
});
