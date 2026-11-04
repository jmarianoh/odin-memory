import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E2E de la célula (estándar sdd-plataforma). Archivo administrado: lo sobrescribe sdd-instalar.sh.
 *
 * Dos proyectos por funcionalidad, uno por cada carpeta funcionalidades/<funcionalidad>/e2e:
 * - `<funcionalidad>-api`: archivos *.api.spec.ts, cliente `request` contra el BFF de la funcionalidad.
 * - `<funcionalidad>-ui`:  archivos *.ui.spec.ts, Chromium contra la app de la funcionalidad.
 *
 * Los API y MS compartidos (servicios/<repo>/) no tienen E2E propio: se prueban a través del BFF de
 * cada funcionalidad que los usa.
 *
 * URLs: BFF_URL_<FUNCIONALIDAD> y APP_URL_<FUNCIONALIDAD> (mayúsculas, guiones como _), o BFF_URL y APP_URL
 * cuando se corre una sola funcionalidad.
 *
 * Correr: sh ci/e2e.sh <funcionalidad> ["@spec-004"]   ·   todas: sh ci/e2e.sh --todos ["<tags>"]
 */
const raiz = join(__dirname, 'funcionalidades');
const funcionalidades = existsSync(raiz)
  ? readdirSync(raiz, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(raiz, d.name, 'e2e')))
      .map((d) => d.name)
  : [];

const url = (tipo: 'BFF' | 'APP', funcionalidad: string, porDefecto: string) =>
  process.env[`${tipo}_URL_${funcionalidad.toUpperCase().replace(/-/g, '_')}`] ??
  process.env[`${tipo}_URL`] ??
  porDefecto;

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'results.xml' }]],
  use: {
    trace: 'on-first-retry',
  },
  projects: funcionalidades.flatMap((f) => [
    {
      name: `${f}-api`,
      testDir: join(raiz, f, 'e2e'),
      testMatch: /.*\.api\.spec\.ts/,
      use: { baseURL: url('BFF', f, 'http://localhost:3000') },
    },
    {
      name: `${f}-ui`,
      testDir: join(raiz, f, 'e2e'),
      testMatch: /.*\.ui\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: url('APP', f, 'http://localhost:4200') },
    },
  ]),
});
