import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout, RequireAuth } from './components/Layout';
import { ClustersPage } from './pages/ClustersPage';
import { GpusPage } from './pages/GpusPage';
import { LoginPage } from './pages/LoginPage';
import { NodeDetailPage } from './pages/NodeDetailPage';
import { NodesPage } from './pages/NodesPage';
import { ProvisionPage } from './pages/ProvisionPage';

export function App(): ReactElement {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/clusters" element={<ClustersPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/nodes/:id" element={<NodeDetailPage />} />
          <Route path="/gpus" element={<GpusPage />} />
          <Route path="/provision" element={<ProvisionPage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/nodes" replace />} />
    </Routes>
  );
}
