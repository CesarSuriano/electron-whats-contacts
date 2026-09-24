import { ErrorHandler, Injectable } from '@angular/core';

import { telemetry } from './telemetry';

// Mantém o comportamento padrão do Angular (log no console) e registra o erro.
@Injectable()
export class TelemetryErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    telemetry.trackError('error.ui', error);
    super.handleError(error);
  }
}
