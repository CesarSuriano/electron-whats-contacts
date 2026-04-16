import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { WhatsappPageComponent } from './pages/whatsapp-page/whatsapp-page.component';

const routes: Routes = [
  {
    path: '',
    component: WhatsappPageComponent
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class WhatsappRoutingModule {}
