import { ErrorHandler, NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { RouteReuseStrategy } from '@angular/router';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { CacheRouteReuseStrategy } from './route-reuse.strategy';
import { TelemetryErrorHandler } from './telemetry/telemetry-error-handler';

@NgModule({
  declarations: [
    AppComponent
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    AppRoutingModule
  ],
  providers: [
    { provide: RouteReuseStrategy, useClass: CacheRouteReuseStrategy },
    { provide: ErrorHandler, useClass: TelemetryErrorHandler }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
