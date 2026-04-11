import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { initDb, logCall } from '../src/db.js';
import type { CallRecord } from '../src/types.js';

// Helper to create timestamps spread over past 24 hours
function hoursAgo(hours: number): string {
  const date = new Date();
  date.setHours(date.getHours() - hours);
  return date.toISOString();
}

const demoCallRecords: Omit<CallRecord, 'id'>[] = [
  // BLOCKED CALLS
  {
    caller_number: '+18005551234',
    caller_name: 'IRS Tax Services',
    stated_relationship: 'IRS Agent',
    stated_purpose: 'Urgent tax matter requiring immediate payment',
    knew_recipient_name: false,
    confidence_score: 0.05,
    risk_reasoning: 'Red flags: IRS impersonation, urgent payment demand, unknown caller, high-pressure tactics. Legitimate IRS contacts by mail first.',
    outcome: 'blocked',
    transcript: 'Caller: This is the IRS. You owe $5,000 in back taxes. You must pay immediately or face arrest.',
    created_at: hoursAgo(2.5),
  },
  {
    caller_number: '+19175558888',
    caller_name: 'Windows Technical Support',
    stated_relationship: 'Microsoft Support Technician',
    stated_purpose: 'Computer has virus, needs immediate remote access',
    knew_recipient_name: false,
    confidence_score: 0.02,
    risk_reasoning: 'Red flags: Tech support scam, unsolicited call, requesting remote access, Microsoft does not make outbound support calls.',
    outcome: 'blocked',
    transcript: 'Caller: Your computer is infected with a virus. We detected it from our systems. I need to remote into your computer to fix it.',
    created_at: hoursAgo(8),
  },
  {
    caller_number: '+13055559876',
    caller_name: 'Unknown',
    stated_relationship: 'Grandson',
    stated_purpose: 'Emergency bail money needed',
    knew_recipient_name: true,
    confidence_score: 0.08,
    risk_reasoning: 'Red flags: Grandparent scam pattern, urgent money request, claims to be family member, pressure tactics, requests secrecy.',
    outcome: 'blocked',
    transcript: 'Caller: Grandma, it\'s me! I\'m in trouble. I got arrested and need $2,000 for bail right now. Please don\'t tell mom and dad.',
    created_at: hoursAgo(15),
  },

  // FORWARDED CALLS
  {
    caller_number: '+14155552200',
    caller_name: 'Dr. Sarah Chen',
    stated_relationship: 'Primary care physician',
    stated_purpose: 'Following up on recent lab results',
    knew_recipient_name: true,
    confidence_score: 0.92,
    risk_reasoning: 'Legitimate medical call. Caller knew recipient name, provided specific context about recent appointment, professional demeanor.',
    outcome: 'forwarded',
    transcript: 'Caller: This is Dr. Chen from City Medical. I wanted to discuss your lab results from last week\'s visit.',
    created_at: hoursAgo(4),
  },
  {
    caller_number: '+16505553344',
    caller_name: 'Emily',
    stated_relationship: 'Daughter',
    stated_purpose: 'Calling to check in and chat',
    knew_recipient_name: true,
    confidence_score: 0.98,
    risk_reasoning: 'Trusted caller. Natural conversation, familiar relationship, no unusual requests.',
    outcome: 'forwarded',
    transcript: 'Caller: Hi Dad, it\'s Emily. Just wanted to call and see how you\'re doing this week.',
    created_at: hoursAgo(18),
  },
  {
    caller_number: '+16505554567',
    caller_name: 'Walgreens Pharmacy',
    stated_relationship: 'Pharmacist',
    stated_purpose: 'Prescription ready for pickup',
    knew_recipient_name: true,
    confidence_score: 0.89,
    risk_reasoning: 'Legitimate pharmacy notification. Caller provided specific prescription details, known pharmacy location.',
    outcome: 'forwarded',
    transcript: 'Caller: This is Walgreens on Main Street. Your prescription for lisinopril is ready for pickup.',
    created_at: hoursAgo(6),
  },
  {
    caller_number: '+14085556789',
    caller_name: 'John Martinez',
    stated_relationship: 'Neighbor',
    stated_purpose: 'Borrowing lawn equipment',
    knew_recipient_name: true,
    confidence_score: 0.85,
    risk_reasoning: 'Known neighbor, reasonable request, familiar voice pattern, casual conversation.',
    outcome: 'forwarded',
    transcript: 'Caller: Hey, it\'s John from next door. I was wondering if I could borrow your leaf blower this weekend?',
    created_at: hoursAgo(12),
  },

  // HELD CALLS
  {
    caller_number: '+18885557890',
    caller_name: 'Medicare Advisor',
    stated_relationship: 'Insurance representative',
    stated_purpose: 'Discuss Medicare plan options',
    knew_recipient_name: false,
    confidence_score: 0.45,
    risk_reasoning: 'Uncertain legitimacy. Unsolicited Medicare call could be sales or scam. Recommending recipient review before engaging.',
    outcome: 'held',
    transcript: 'Caller: I\'m calling about your Medicare coverage. We have new plans available that could save you money.',
    created_at: hoursAgo(10),
  },
  {
    caller_number: '+17605551122',
    caller_name: 'Unknown',
    stated_relationship: 'Old friend',
    stated_purpose: 'Reconnecting after many years',
    knew_recipient_name: true,
    confidence_score: 0.55,
    risk_reasoning: 'Moderate risk. Claims to be old friend but lacks specific shared memories. Could be legitimate or social engineering attempt.',
    outcome: 'held',
    transcript: 'Caller: Hi! Remember me from high school? I found your number and wanted to reconnect after all these years.',
    created_at: hoursAgo(22),
  },
];

async function seedDemo() {
  console.log('🌱 Starting demo database seed...\n');

  const db = new Database('guardline.db');
  initDb(db);

  console.log(`Inserting ${demoCallRecords.length} demo call records:\n`);

  for (const record of demoCallRecords) {
    const callRecord: CallRecord = {
      id: randomUUID(),
      ...record,
    };

    logCall(db, callRecord);

    const hoursAgoValue = Math.abs(new Date(record.created_at).getTime() - Date.now()) / (1000 * 60 * 60);
    console.log(
      `✓ ${callRecord.outcome.toUpperCase().padEnd(11)} | ${hoursAgoValue.toFixed(1)}h ago | ${callRecord.caller_name || 'Unknown'} (${callRecord.caller_number})`
    );
  }

  db.close();

  console.log('\n✅ Demo seed complete!');
  console.log('\nNext steps:');
  console.log('1. Start server: npm run dev');
  console.log('2. View dashboard: http://localhost:3000');
  console.log('3. Check API: curl http://localhost:3000/api/calls\n');
}

seedDemo().catch((error) => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});
