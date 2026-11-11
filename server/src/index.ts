import { deploymentRole, validateDeployment } from './deployment.js';
validateDeployment();
switch (deploymentRole) {
  case 'standalone':
  case 'tenant': await import('./tenant-app.js'); break;
  case 'platform': await (await import('./platform/server.js')).startPlatform(); break;
  case 'composio-gateway': await (await import('./platform/composio-gateway.js')).startComposioGateway(); break;
  case 'provisioner': await (await import('./platform/provisioner.js')).startProvisioner(); break;
}
