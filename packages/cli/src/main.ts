#!/usr/bin/env -S node --import tsx
import { connectVerified } from '@med/db';

try {
    const db = await connectVerified();
    await db.$client.end();
    console.log('✓ Database connection OK');
} catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    process.exit(1);
}
