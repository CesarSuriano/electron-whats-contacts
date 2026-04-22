import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { AgentPageComponent } from './pages/agent-page/agent-page.component';

const routes: Routes = [
  {
    path: '',
    component: AgentPageComponent
  }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AgentRoutingModule {}