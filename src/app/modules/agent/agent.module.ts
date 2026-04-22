import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { SharedModule } from '../shared/shared.module';
import { AgentRoutingModule } from './agent-routing.module';
import { AgentPageComponent } from './pages/agent-page/agent-page.component';

@NgModule({
  declarations: [AgentPageComponent],
  imports: [CommonModule, FormsModule, SharedModule, AgentRoutingModule]
})
export class AgentModule {}