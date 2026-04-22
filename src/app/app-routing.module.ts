import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadChildren: () => import('./modules/home/home.module').then(m => m.HomeModule)
  },
  {
    path: 'agente',
    loadChildren: () => import('./modules/agent/agent.module').then(m => m.AgentModule)
  },
  {
    path: 'whatsapp',
    loadChildren: () => import('./modules/whatsapp/whatsapp.module').then(m => m.WhatsappModule)
  },
  {
    path: '**',
    redirectTo: ''
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
