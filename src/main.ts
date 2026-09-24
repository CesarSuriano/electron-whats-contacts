import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { AppModule } from './app/app.module';
import { telemetry } from './app/telemetry/telemetry';


platformBrowserDynamic().bootstrapModule(AppModule)
  .then(() => telemetry.track('ui.app_start', { bootMs: Math.round(performance.now()) }))
  .catch(err => {
    telemetry.trackError('error.ui_bootstrap', err);
    console.error(err);
  });
