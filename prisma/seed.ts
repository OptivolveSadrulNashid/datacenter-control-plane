import { GpuHealth, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma.js';

const USERS = [
  { email: 'admin@icp.local', password: 'admin12345', role: Role.ADMIN },
  { email: 'operator@icp.local', password: 'operator12345', role: Role.OPERATOR },
  { email: 'viewer@icp.local', password: 'viewer12345', role: Role.VIEWER },
];

async function main(): Promise<void> {
  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: {},
      create: {
        email: user.email,
        role: user.role,
        passwordHash: await bcrypt.hash(user.password, 10),
      },
    });
  }

  const cluster = await prisma.cluster.upsert({
    where: { name: 'us-east-1a' },
    update: {},
    create: { name: 'us-east-1a', location: 'Ashburn, VA' },
  });

  for (const name of ['R01', 'R02']) {
    await prisma.rack.upsert({
      where: { clusterId_name: { clusterId: cluster.id, name } },
      update: {},
      create: { clusterId: cluster.id, name },
    });
  }

  // Spare GPU inventory, not yet attached to any node.
  const spares = [
    { vendor: 'NVIDIA', model: 'H100', memoryMb: 81_920, serialNumber: 'SPARE-H100-0001' },
    { vendor: 'NVIDIA', model: 'H100', memoryMb: 81_920, serialNumber: 'SPARE-H100-0002' },
    { vendor: 'AMD', model: 'MI300X', memoryMb: 196_608, serialNumber: 'SPARE-MI300X-0001' },
  ];
  for (const gpu of spares) {
    await prisma.gpu.upsert({
      where: { serialNumber: gpu.serialNumber },
      update: {},
      create: { ...gpu, healthStatus: GpuHealth.HEALTHY },
    });
  }

  const racks = await prisma.rack.findMany({ where: { clusterId: cluster.id } });
  console.log('Seeded:');
  console.log(`  cluster ${cluster.name} (${cluster.id})`);
  for (const rack of racks) console.log(`  rack ${rack.name} (${rack.id})`);
  console.log('  users: admin@icp.local / operator@icp.local / viewer@icp.local');
  console.log('  passwords: admin12345 / operator12345 / viewer12345');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
