/**
 * Westin College Portal — database seed.
 *
 * Mirrors the frontend mock data:
 *   ../Student_portal/src/data/{mockData,attendanceData,studyMaterialsData}.ts
 *   ../faculty_admin_portal/src/data/{sharedData,facultyData,adminData,adminTimetableData}.ts
 *
 * - Deterministic (no Math.random): re-runs produce identical data.
 * - Idempotent: truncates every data table first.
 * - Uploads tiny real bytes to Supabase Storage for study files + report attachments.
 * - Seeded students use the admin-assigned default password `Password@123`.
 * - Seeded faculty/admin accounts authenticate with OTP only.
 *
 * Run: npm run seed
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient } from 'pg';
import { hashPassword } from '../src/common/util/crypto';

/* ---------------------------------------------------------- env (same loading style as scripts/migrate.ts / src/config/env.ts) */

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (check westin-api/.env)`);
  return value;
}

const DATABASE_URL = required('DATABASE_URL');
const SUPABASE_URL = required('SUPABASE_URL').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

// Mirrors BUCKETS from src/modules/storage/storage.service.ts (not imported — that
// file pulls in @nestjs/common decorators).
const BUCKET_STUDY = 'study-materials';
const BUCKET_REPORTS = 'report-attachments';

const PASSWORD = 'Password@123';

/* ---------------------------------------------------------- date helpers (Asia/Kolkata based) */

const TZ = 'Asia/Kolkata';

function todayISO(): string {
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** b - a in whole days. */
function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Mock files are dated around the 2026-08-16 "today" of the frontend mocks. */
const MOCK_ANCHOR = '2026-08-16';
const TODAY = todayISO();
/** Shift a mock ISO date (2026-08-xx) onto the current calendar, keeping spacing. */
const shiftFromMock = (iso: string) => addDaysISO(iso, diffDays(MOCK_ANCHOR, TODAY));

/** 0 = Sunday .. 6 = Saturday. */
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/* ---------------------------------------------------------- mock data (mirrored inline) */

const PERIODS = [
  { id: 'h1', start: '09:00', end: '10:00' },
  { id: 'h2', start: '10:15', end: '11:15' },
  { id: 'h3', start: '11:30', end: '12:30' },
  { id: 'h4', start: '13:15', end: '14:15' },
  { id: 'h5', start: '14:30', end: '15:30' },
  { id: 'h6', start: '15:45', end: '16:45' },
] as const;

const ADMIN = {
  name: 'Ananya Verma',
  adminId: 'ADM-2025-002',
  title: 'Super Admin',
  email: 'ananya.verma@westin.edu',
};

const DEMO_STUDENT = {
  // Student_portal/src/data/mockData.ts -> student
  name: 'Balarakesh G.',
  studentId: 'STU-2025-001',
  email: 'balarakesh.g@university.edu',
  department: 'CSE - AIML',
};

interface FacultySeed {
  key: string; // mock fac-00x key used by subjectFaculty
  facultyId: string;
  name: string;
  designation: string;
  department: string;
  email: string;
  phone: string;
  status: 'active' | 'inactive';
}

// faculty_admin_portal/src/data/adminData.ts -> teachers (emails/phones/designations).
// Faculty ids: Dr. Priya Sharma is FAC-2025-014 (facultyData.ts); the rest get a
// unique sequence around hers.
const FACULTY: FacultySeed[] = [
  { key: 'fac-001', facultyId: 'FAC-2025-011', name: 'Dr. Shreeram Hudda', designation: 'Professor', department: 'CSE - AIML', email: 'shreeram.hudda@westin.edu', phone: '+91 98450 11201', status: 'active' },
  { key: 'fac-002', facultyId: 'FAC-2025-012', name: 'Dr. Ravi Kant Kumar', designation: 'Professor', department: 'CSE - AIML', email: 'ravi.kant@westin.edu', phone: '+91 98450 11202', status: 'active' },
  { key: 'fac-003', facultyId: 'FAC-2025-013', name: 'Dr. Anil Kumar', designation: 'Professor', department: 'CSE', email: 'anil.kumar@westin.edu', phone: '+91 98450 11203', status: 'active' },
  { key: 'fac-004', facultyId: 'FAC-2025-014', name: 'Dr. Priya Sharma', designation: 'Associate Professor', department: 'CSE - AIML', email: 'priya.sharma@westin.edu', phone: '+91 98450 11204', status: 'active' },
  { key: 'fac-005', facultyId: 'FAC-2025-015', name: 'Dr. Meera Krishnan', designation: 'Assistant Professor', department: 'CSE', email: 'meera.krishnan@westin.edu', phone: '+91 98450 11205', status: 'active' },
  { key: 'fac-006', facultyId: 'FAC-2025-016', name: 'Dr. Arjun Rao', designation: 'Professor', department: 'CSE - AIML', email: 'arjun.rao@westin.edu', phone: '+91 98450 11206', status: 'active' },
  { key: 'fac-007', facultyId: 'FAC-2025-017', name: 'Prof. Sneha Iyer', designation: 'Assistant Professor', department: 'Humanities', email: 'sneha.iyer@westin.edu', phone: '+91 98450 11207', status: 'active' },
  { key: 'fac-008', facultyId: 'FAC-2025-018', name: 'Dr. Kavitha Reddy', designation: 'Associate Professor', department: 'IT', email: 'kavitha.reddy@westin.edu', phone: '+91 98450 11208', status: 'inactive' },
];

interface SectionSeed {
  key: string;
  label: string;
  department: string;
  year: number;
  rollPrefix: string;
  classTeacher: string; // faculty key
}

// sharedData.ts -> sections
const SECTIONS: SectionSeed[] = [
  { key: 'cse-aiml-3a', label: 'CSE-AIML 3A', department: 'CSE - AIML', year: 3, rollPrefix: '23CA3A', classTeacher: 'fac-004' },
  { key: 'cse-aiml-3b', label: 'CSE-AIML 3B', department: 'CSE - AIML', year: 3, rollPrefix: '23CA3B', classTeacher: 'fac-001' },
  { key: 'cse-aiml-3c', label: 'CSE-AIML 3C', department: 'CSE - AIML', year: 3, rollPrefix: '23CA3C', classTeacher: 'fac-005' },
  { key: 'cse-aiml-3d', label: 'CSE-AIML 3D', department: 'CSE - AIML', year: 3, rollPrefix: '23CA3D', classTeacher: 'fac-006' },
  { key: 'cse-3a', label: 'CSE 3A', department: 'CSE', year: 3, rollPrefix: '23CS3A', classTeacher: 'fac-002' },
  { key: 'cse-3b', label: 'CSE 3B', department: 'CSE', year: 3, rollPrefix: '23CS3B', classTeacher: 'fac-003' },
];

// sharedData.ts -> subjects
const SUBJECTS = [
  { key: 'cs301', name: 'Data Structures & Algorithms', code: 'CS301' },
  { key: 'cs302', name: 'Database Management Systems', code: 'CS302' },
  { key: 'cs303', name: 'Operating Systems', code: 'CS303' },
  { key: 'cs304', name: 'Machine Learning', code: 'CS304' },
  { key: 'cs305', name: 'Computer Networks', code: 'CS305' },
  { key: 'cs306', name: 'Artificial Intelligence', code: 'CS306' },
  { key: 'hs301', name: 'Soft Skills & Communication', code: 'HS301' },
  { key: 'oe302', name: 'Cloud Computing', code: 'OE302' },
];

// adminTimetableData.ts -> subjectFaculty
const SUBJECT_FACULTY: Record<string, string> = {
  cs301: 'fac-001',
  cs302: 'fac-002',
  cs303: 'fac-003',
  cs304: 'fac-004',
  cs305: 'fac-005',
  cs306: 'fac-006',
  hs301: 'fac-007',
  oe302: 'fac-003',
};

// Extra faculty_subjects link: Dr. Kavitha Reddy teaches DBMS per adminData.teachers
// ("Web Technologies" is not one of the 8 seeded subjects, so only DBMS is linked).
const EXTRA_FACULTY_SUBJECTS: Array<[string, string]> = [['fac-008', 'cs302']];

// adminTimetableData.ts -> rooms (labels)
const ROOM_NAMES = [
  'Room 204', 'Room 301', 'Room 302', 'Room 305', 'Room 308', 'Room 309',
  'Room 310', 'Room 311', 'Room 405', 'Lab 2', 'Lab 3', 'Lab 4',
  'Seminar Hall', 'Auditorium B', 'Innovation Hub',
];

// adminTimetableData.ts -> sectionRooms (home room per section)
const SECTION_HOME_ROOM: Record<string, string> = {
  'cse-aiml-3a': 'Room 308',
  'cse-aiml-3b': 'Room 309',
  'cse-aiml-3c': 'Room 310',
  'cse-aiml-3d': 'Room 311',
  'cse-3a': 'Room 301',
  'cse-3b': 'Room 302',
};

// adminTimetableData.ts -> fourthPeriodRooms
const FOURTH_PERIOD_ROOMS = ['Lab 2', 'Lab 3', 'Lab 4', 'Room 405', 'Seminar Hall', 'Innovation Hub'];

// adminTimetableData.ts -> sectionPlan
const SECTION_PLAN: Record<string, string[]> = {
  'cse-aiml-3a': ['cs301', 'cs302', 'cs303', 'cs304'],
  'cse-aiml-3b': ['cs305', 'cs306', 'cs302', 'cs304'],
  'cse-aiml-3c': ['cs303', 'cs304', 'cs305', 'cs301'],
  'cse-aiml-3d': ['cs306', 'cs301', 'cs304', 'cs302'],
  'cse-3a': ['cs302', 'cs303', 'oe302', 'hs301'],
  'cse-3b': ['cs301', 'cs305', 'oe302', 'hs301'],
};

/**
 * CSE-AIML 3A week, mirrored from Student_portal mockData.weeklyTimetable
 * (rooms + subjects). Lab/elective-only mock subjects (CS351/CS352/CS390/CS391)
 * map to their nearest seeded subject; periods map onto canonical h1..hN.
 * Note: Monday is an exact match with the mock (DSA, DBMS, OS, ML).
 */
const SECTION_3A_WEEK: Record<number, Array<{ subject: string; room: string }>> = {
  0: [
    { subject: 'cs301', room: 'Room 301' },
    { subject: 'cs302', room: 'Room 305' },
    { subject: 'cs303', room: 'Room 302' },
    { subject: 'cs304', room: 'Room 308' },
  ],
  1: [
    { subject: 'cs305', room: 'Room 204' },
    { subject: 'cs306', room: 'Room 310' },
    { subject: 'cs301', room: 'Lab 2' },      // mock: Data Structures Lab
    { subject: 'cs304', room: 'Room 308' },
  ],
  2: [
    { subject: 'cs303', room: 'Room 302' },
    { subject: 'cs302', room: 'Room 305' },
    { subject: 'cs305', room: 'Room 204' },
    { subject: 'hs301', room: 'Auditorium B' },
  ],
  3: [
    { subject: 'cs304', room: 'Room 308' },
    { subject: 'cs306', room: 'Room 310' },
    { subject: 'cs302', room: 'Lab 4' },      // mock: DBMS Lab
    { subject: 'cs301', room: 'Room 301' },
  ],
  4: [
    { subject: 'cs306', room: 'Room 310' },
    { subject: 'cs305', room: 'Room 204' },
    { subject: 'cs303', room: 'Room 302' },
    { subject: 'cs304', room: 'Innovation Hub' }, // mock: Project Mentoring
  ],
  5: [
    { subject: 'cs306', room: 'Seminar Hall' },   // mock: ML Workshop (Dr. Arjun Rao)
    { subject: 'cs301', room: 'Room 301' },
    { subject: 'oe302', room: 'Room 405' },       // mock: Open Elective: Cloud Computing
  ],
};

// sharedData.ts -> rosterNames (one pool of 40 names, reused per section)
const ROSTER_NAMES = [
  'Aarav Sharma', 'Aditi Nair', 'Akash Verma', 'Ananya Iyer', 'Arjun Mehta',
  'Bhavana Rao', 'Charan Teja', 'Deepak Naidu', 'Divya Krishnan', 'Eshwar Reddy',
  'Gauri Patil', 'Harish Kumar', 'Ishaani Gupta', 'Jayanandan S.', 'Kavya Menon',
  'Kiran Desai', 'Lakshmi Prasad', 'Madhav Joshi', 'Meera Pillai', 'Naveen Chandra',
  'Nikhila Reddy', 'Om Prakash', 'Pooja Hegde', 'Pranav Kulkarni', 'Raghav Sinha',
  'Riya Kapoor', 'Rohit Malhotra', 'Saanvi Shetty', 'Sandeep Raju', 'Sharanya Bhat',
  'Siddharth Jain', 'Sneha Mohan', 'Surya Prakash', 'Tanvi Deshmukh', 'Tejas Kadam',
  'Umesh Yadav', 'Vaishnavi Menon', 'Varun Saxena', 'Yash Agarwal', 'Zoya Khan',
];

// adminData.ts studentTuples -> inactive students (present in the shared roster)
const INACTIVE_STUDENTS = new Set([
  'Arjun Mehta',      // cse-aiml-3a
  'Madhav Joshi',     // cse-aiml-3b
  'Rohit Malhotra',   // cse-aiml-3c
  'Umesh Yadav',      // cse-aiml-3d
]);

// sharedData.ts -> eventsPool (dates shifted relative to today at seed time)
interface EventSeed {
  title: string;
  category: 'CULTURAL' | 'TECH TALK' | 'SPORTS' | 'WORKSHOP' | 'SEMINAR';
  dayOffset: number; // days from today
  endDayOffset: number | null;
  time: string;
  location: string;
  isLive: boolean;
  createdBy: string; // faculty key or 'admin'
}
const EVENTS: EventSeed[] = [
  { title: 'RHYTHM 2K26', category: 'CULTURAL', dayOffset: 1, endDayOffset: 3, time: '09:00 AM – 08:00 PM', location: 'Main Auditorium & Open Grounds', isLive: true, createdBy: 'fac-006' },
  { title: 'AI & Society: A Tech Talk', category: 'TECH TALK', dayOffset: 5, endDayOffset: null, time: '02:00 PM – 04:00 PM', location: 'Seminar Hall B', isLive: false, createdBy: 'fac-004' },
  { title: 'Inter-Department Football', category: 'SPORTS', dayOffset: 8, endDayOffset: null, time: '04:30 PM – 06:30 PM', location: 'Westin Sports Complex', isLive: false, createdBy: 'fac-005' },
  { title: 'Machine Learning Bootcamp', category: 'WORKSHOP', dayOffset: 13, endDayOffset: null, time: '10:00 AM – 01:00 PM', location: 'Lab 3, CSE Block', isLive: false, createdBy: 'fac-004' },
  // mock creator "Dr. Vikram Mehta" is not among the 8 seeded teachers -> admin creates it
  { title: 'Industry Connect Seminar', category: 'SEMINAR', dayOffset: 17, endDayOffset: null, time: '11:00 AM – 01:00 PM', location: 'Auditorium A', isLive: false, createdBy: 'admin' },
  { title: 'Project Demo Day', category: 'SEMINAR', dayOffset: 20, endDayOffset: null, time: '09:30 AM – 12:30 PM', location: 'Innovation Hub', isLive: false, createdBy: 'fac-004' },
];

// sharedData.ts -> announcements (dates shifted)
const ANNOUNCEMENTS = [
  { title: 'Mid-Semester Exam Timetable Released', message: 'Shares with all sections — verify slots before Friday.', category: 'exam' as const, dayOffset: -2, hour: 10 },
  { title: 'Daily Reports Due Every Evening', message: 'Submit the class report before 6:00 PM on teaching days.', category: 'general' as const, dayOffset: -4, hour: 9 },
  { title: 'Library Extended Hours During Exams', message: 'The central library will remain open until 10 PM from next week.', category: 'general' as const, dayOffset: -6, hour: 15 },
];

// sharedData.ts -> studyFiles (8 files; dates shifted)
interface StudyFileSeed {
  name: string;
  subject: string;
  type: 'pdf' | 'docx' | 'pptx' | 'xlsx';
  size: string; // human size from mock, parsed to bytes
  uploadedBy: string; // faculty key
  description: string;
  dayOffset: number;
}
const STUDY_FILES: StudyFileSeed[] = [
  { name: 'ML_Unit1_Introduction.pdf', subject: 'cs304', type: 'pdf', size: '2.4 MB', uploadedBy: 'fac-004', description: 'Unit 1 — Introduction to Machine Learning', dayOffset: -2 },
  { name: 'Regression_Notes.docx', subject: 'cs304', type: 'docx', size: '1.1 MB', uploadedBy: 'fac-004', description: 'Linear & logistic regression worked notes', dayOffset: -4 },
  { name: 'Operating_Systems_Overview.pptx', subject: 'cs303', type: 'pptx', size: '3.7 MB', uploadedBy: 'fac-003', description: 'Complete OS overview slides', dayOffset: -6 },
  { name: 'Process_Scheduling.pdf', subject: 'cs303', type: 'pdf', size: '1.8 MB', uploadedBy: 'fac-003', description: 'CPU scheduling algorithms', dayOffset: -8 },
  { name: 'DBMS_Normalization.xlsx', subject: 'cs302', type: 'xlsx', size: '956 KB', uploadedBy: 'fac-002', description: 'Normalization examples worksheet', dayOffset: -9 },
  { name: 'DSA_Unit_1_Introduction.pdf', subject: 'cs301', type: 'pdf', size: '2.1 MB', uploadedBy: 'fac-001', description: 'Unit 1 — Introduction to Data Structures', dayOffset: -11 },
  { name: 'CNN_Architectures.pptx', subject: 'cs306', type: 'pptx', size: '4.2 MB', uploadedBy: 'fac-006', description: 'Convolutional neural networks deep-dive', dayOffset: -13 },
  { name: 'Network_Topologies.pdf', subject: 'cs305', type: 'pdf', size: '1.5 MB', uploadedBy: 'fac-005', description: 'Topologies and the OSI model', dayOffset: -15 },
];

// facultyData.ts -> facultyReports (5, Dr. Priya Sharma) +
// adminData.ts -> adminReports ar-1..ar-5 (5 more, last 7 days incl today).
// Mock subjects "Machine Learning Lab" and "Project Mentoring" map to CS304.
interface ReportSeed {
  faculty: string;
  section: string;
  subject: string;
  topic: string;
  fileName: string;
  fileType: 'pdf' | 'docx' | 'pptx' | 'xlsx';
  dayOffset: number;
}
const REPORTS: ReportSeed[] = [
  { faculty: 'fac-004', section: 'cse-aiml-3a', subject: 'cs304', topic: 'Linear regression — gradient descent walkthrough', fileName: 'ML_3A_14Aug.pdf', fileType: 'pdf', dayOffset: -2 },
  { faculty: 'fac-004', section: 'cse-aiml-3b', subject: 'cs304', topic: 'Logistic regression & classification metrics', fileName: 'ML_3B_13Aug.pdf', fileType: 'pdf', dayOffset: -3 },
  { faculty: 'fac-004', section: 'cse-aiml-3a', subject: 'cs304', topic: 'Lab 4 — implementing regression from scratch', fileName: 'MLLab_3A_12Aug.docx', fileType: 'docx', dayOffset: -4 },
  { faculty: 'fac-004', section: 'cse-aiml-3c', subject: 'cs304', topic: 'Overfitting, regularisation (L1/L2)', fileName: 'ML_3C_11Aug.pdf', fileType: 'pdf', dayOffset: -5 },
  { faculty: 'fac-004', section: 'cse-aiml-3b', subject: 'cs304', topic: 'Sprint 2 reviews — dataset finalisation', fileName: 'PM_3B_10Aug.pdf', fileType: 'pdf', dayOffset: -6 },
  { faculty: 'fac-001', section: 'cse-aiml-3a', subject: 'cs301', topic: 'AVL trees — rotations', fileName: 'DSA_3A_16Aug.pdf', fileType: 'pdf', dayOffset: 0 },
  { faculty: 'fac-003', section: 'cse-aiml-3b', subject: 'cs303', topic: 'Deadlocks — detection & recovery', fileName: 'OS_3B_16Aug.pdf', fileType: 'pdf', dayOffset: 0 },
  { faculty: 'fac-002', section: 'cse-aiml-3a', subject: 'cs302', topic: 'Joins & query optimisation', fileName: 'DBMS_3A_16Aug.pdf', fileType: 'pdf', dayOffset: 0 },
  { faculty: 'fac-005', section: 'cse-aiml-3c', subject: 'cs305', topic: 'TCP congestion control', fileName: 'CN_3C_15Aug.pdf', fileType: 'pdf', dayOffset: -1 },
  { faculty: 'fac-006', section: 'cse-aiml-3b', subject: 'cs306', topic: 'Search algorithms — A* walkthrough', fileName: 'AI_3B_15Aug.pptx', fileType: 'pptx', dayOffset: -1 },
];

// adminData.ts -> teacherLoginLogs + studentLoginLogs (dates shifted).
// Two student-log names (Dhruv Kapoor, Jasleen Kaur) are adminData-only students
// that don't exist in the shared 40-name roster; same-section roster students
// stand in so every log row has a real user_id.
interface LoginLogSeed {
  name: string;
  section?: string; // for student disambiguation
  time: string;
  device: string;
  ip: string;
  dayOffset: number;
}
const TEACHER_LOGS: LoginLogSeed[] = [
  { name: 'Dr. Priya Sharma', time: '08:42 AM', device: 'Windows • Chrome', ip: '10.4.12.36', dayOffset: 0 },
  { name: 'Dr. Shreeram Hudda', time: '08:31 AM', device: 'macOS • Safari', ip: '10.4.9.118', dayOffset: 0 },
  { name: 'Dr. Anil Kumar', time: '08:12 AM', device: 'Windows • Edge', ip: '10.4.15.72', dayOffset: 0 },
  { name: 'Dr. Meera Krishnan', time: '09:05 AM', device: 'Android • Chrome', ip: '172.16.4.51', dayOffset: -1 },
  { name: 'Dr. Priya Sharma', time: '08:47 AM', device: 'Windows • Chrome', ip: '10.4.12.36', dayOffset: -1 },
  { name: 'Dr. Arjun Rao', time: '08:02 AM', device: 'iPad • Safari', ip: '172.16.2.19', dayOffset: -1 },
  { name: 'Prof. Sneha Iyer', time: '10:24 AM', device: 'macOS • Chrome', ip: '10.4.22.87', dayOffset: -2 },
  { name: 'Dr. Ravi Kant Kumar', time: '09:36 AM', device: 'Windows • Firefox', ip: '10.4.8.44', dayOffset: -2 },
  { name: 'Dr. Shreeram Hudda', time: '08:55 AM', device: 'macOS • Safari', ip: '10.4.9.118', dayOffset: -2 },
  { name: 'Dr. Anil Kumar', time: '08:19 AM', device: 'Windows • Edge', ip: '10.4.15.72', dayOffset: -3 },
];
const STUDENT_LOGS: LoginLogSeed[] = [
  { name: DEMO_STUDENT.name, section: 'cse-aiml-3a', time: '08:56 AM', device: 'Android • Chrome', ip: '10.5.31.7', dayOffset: 0 },
  { name: 'Ananya Iyer', section: 'cse-aiml-3a', time: '08:49 AM', device: 'iOS • Safari', ip: '10.5.29.84', dayOffset: 0 },
  { name: 'Deepak Naidu', section: 'cse-3a', time: '08:33 AM', device: 'Windows • Edge', ip: '10.5.44.12', dayOffset: 0 }, // stands in for Dhruv Kapoor
  { name: 'Tanvi Deshmukh', section: 'cse-aiml-3d', time: '09:14 PM', device: 'iOS • Safari', ip: '172.17.8.23', dayOffset: -1 },
  { name: DEMO_STUDENT.name, section: 'cse-aiml-3a', time: '06:40 PM', device: 'Android • Chrome', ip: '10.5.31.7', dayOffset: -1 },
  { name: 'Kavya Menon', section: 'cse-aiml-3b', time: '05:22 PM', device: 'Windows • Chrome', ip: '10.5.18.90', dayOffset: -1 },
  { name: 'Siddharth Jain', section: 'cse-aiml-3d', time: '07:58 PM', device: 'Android • Firefox', ip: '172.17.3.44', dayOffset: -2 },
  { name: 'Gauri Patil', section: 'cse-3b', time: '07:31 PM', device: 'iOS • Safari', ip: '10.5.27.16', dayOffset: -2 }, // stands in for Jasleen Kaur
  { name: 'Riya Kapoor', section: 'cse-aiml-3c', time: '06:05 PM', device: 'macOS • Chrome', ip: '10.5.11.58', dayOffset: -2 },
  { name: 'Tejas Kadam', section: 'cse-aiml-3d', time: '08:12 PM', device: 'Windows • Edge', ip: '10.5.44.12', dayOffset: -3 },
];

/* ---------------------------------------------------------- small utils */

const pad3 = (n: number) => String(n).padStart(3, '0');

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '') // drop extension
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "Dr. Priya Sharma" -> "priya.sharma"; "Jayanandan S." -> "jayanandan.s". */
function nameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim()
    .split(/\s+/)
    .join('.');
}

/** "2.4 MB" / "956 KB" -> bytes. */
function parseSize(size: string): number {
  const m = /^([\d.]+)\s*(MB|KB)$/i.exec(size);
  if (!m) return 1024 * 1024;
  const n = Number(m[1]);
  return Math.round(m[2].toUpperCase() === 'MB' ? n * 1024 * 1024 : n * 1024);
}

/** "08:42 AM" -> "08:42:00". */
function to24h(time: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!m) return '00:00:00';
  let h = Number(m[1]);
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}:00`;
}

const istStamp = (isoDate: string, time24: string) => `${isoDate}T${time24}+05:30`;

/** Minimal but well-formed PDF containing one line of text. */
function makePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n` +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n` +
      `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n` +
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n` +
      `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n` +
      `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n` +
      `trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n`,
    'binary',
  );
}

const FILE_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Tiny stand-in bytes: real PDF for pdf, plain text for the office types. */
function fileBytes(name: string, type: string): Buffer {
  if (type === 'pdf') return makePdf(`Westin College — ${name}`);
  return Buffer.from(
    `Westin College seeded stand-in for ${name} (${type}).\nSeeded by scripts/seed.ts — real office bytes are not needed for signed-URL demos.\n`,
    'utf8',
  );
}

/* ---------------------------------------------------------- storage (inline copy of StorageService.uploadObject) */

async function storageFetch(pathname: string, init: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}${pathname}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      ...(init.headers ?? {}),
    },
  });
}

async function uploadObject(bucket: string, objectPath: string, data: Buffer, contentType: string): Promise<void> {
  const res = await storageFetch(`/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
    // Buffer -> fetch body needs a cast (same as StorageService.uploadObject).
    body: data as never,
  });
  if (!res.ok) throw new Error(`upload ${bucket}/${objectPath} failed (${res.status}): ${await res.text()}`);
}

/* ---------------------------------------------------------- timetable builder (conflict-free, deterministic) */

interface Placement {
  sectionKey: string;
  sectionIndex: number;
  day: number; // 0=Mon..5=Sat
  pi: number; // 0..5 -> h1..h6
  subjectKey: string;
  facultyKey: string;
  roomName: string;
}

function buildTimetable(): Placement[] {
  const facUsed = new Set<string>(); // `${day}|${pi}|${facultyKey}`
  const roomUsed = new Set<string>(); // `${day}|${pi}|${roomName}`
  const placements: Placement[] = [];

  const place = (p: Omit<Placement, 'facultyKey'> & { facultyKey?: string }): Placement => {
    const facultyKey = p.facultyKey ?? SUBJECT_FACULTY[p.subjectKey];
    const fk = `${p.day}|${p.pi}|${facultyKey}`;
    const rk = `${p.day}|${p.pi}|${p.roomName}`;
    const sk = `${p.sectionKey}|${p.day}|${p.pi}`;
    if (facUsed.has(fk)) throw new Error(`timetable faculty conflict: ${fk}`);
    if (roomUsed.has(rk)) throw new Error(`timetable room conflict: ${rk}`);
    if (placements.some((q) => `${q.sectionKey}|${q.day}|${q.pi}` === sk)) {
      throw new Error(`timetable section/period conflict: ${sk}`);
    }
    facUsed.add(fk);
    roomUsed.add(rk);
    const placement: Placement = { ...p, facultyKey };
    placements.push(placement);
    return placement;
  };

  // Section 0 (CSE-AIML 3A): hardcoded from the student portal mock week.
  for (const [dayStr, entries] of Object.entries(SECTION_3A_WEEK)) {
    const day = Number(dayStr);
    entries.forEach((e, pi) => {
      place({ sectionKey: SECTIONS[0].key, sectionIndex: 0, day, pi, subjectKey: e.subject, roomName: e.room });
    });
  }

  const allSubjectKeys = SUBJECTS.map((s) => s.key);

  // Sections 1..5: greedy, conflict-free allocation rotating the sharedData plans.
  for (let si = 1; si < SECTIONS.length; si++) {
    const section = SECTIONS[si];
    const plan = SECTION_PLAN[section.key];
    const home = SECTION_HOME_ROOM[section.key];
    const fourth = FOURTH_PERIOD_ROOMS[si % FOURTH_PERIOD_ROOMS.length];
    const roomCandidates = (pi: number): string[] => {
      const preferred = pi < 3 ? [home, ...ROOM_NAMES] : [fourth, home, ...ROOM_NAMES];
      return [...new Set(preferred)];
    };

    for (let day = 0; day < 6; day++) {
      const periodCount = 4 + ((si + day) % 3); // 4..6 periods/day
      const usedToday = new Set<string>();
      for (let pi = 0; pi < periodCount; pi++) {
        const rotation = plan[(day + pi) % plan.length];
        const candidateOrder = [
          rotation,
          ...plan.filter((s) => s !== rotation),
          ...allSubjectKeys.filter((s) => !plan.includes(s)),
        ];

        let subjectKey: string | undefined;
        // Prefer subjects this section doesn't already have today.
        subjectKey = candidateOrder.find(
          (s) => !usedToday.has(s) && !facUsed.has(`${day}|${pi}|${SUBJECT_FACULTY[s]}`),
        );
        if (!subjectKey) {
          subjectKey = candidateOrder.find((s) => !facUsed.has(`${day}|${pi}|${SUBJECT_FACULTY[s]}`));
        }
        if (!subjectKey) throw new Error(`timetable: no free faculty for ${section.key} day ${day} h${pi + 1}`);

        const roomName = roomCandidates(pi).find((r) => !roomUsed.has(`${day}|${pi}|${r}`));
        if (!roomName) throw new Error(`timetable: no free room for ${section.key} day ${day} h${pi + 1}`);

        place({ sectionKey: section.key, sectionIndex: si, day, pi, subjectKey, roomName });
        usedToday.add(subjectKey);
      }
    }
  }

  return placements;
}

/* ---------------------------------------------------------- batch insert helper */

async function insertMany(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  returning?: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const chunkSize = Math.min(1000, Math.max(1, Math.floor(60000 / columns.length)));
  for (let c = 0; c < rows.length; c += chunkSize) {
    const chunk = rows.slice(c, c + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk
      .map((row, ri) => `(${row.map((_, vi) => `$${ri * columns.length + vi + 1}`).join(', ')})`)
      .join(', ');
    for (const row of chunk) values.push(...row);
    const sql = `insert into ${table} (${columns.join(', ')}) values ${tuples}${returning ? ` returning ${returning}` : ''}`;
    const res = await client.query(sql, values as never[]);
    if (returning) out.push(...(res.rows as Record<string, unknown>[]));
  }
  return out;
}

/* ---------------------------------------------------------- main */

async function main() {
  console.log(`Seeding westin-api (today = ${TODAY}, mock anchor = ${MOCK_ANCHOR}) ...`);

  /* ---- 1. Build everything in memory (deterministic) ---- */

  const passwordHash = hashPassword(PASSWORD); // shared hash: same salt for the demo password, hashed once for speed

  // Users: admin + 8 faculty + 240 students (demo student included in section 3A).
  interface NewUser {
    role: 'student' | 'faculty' | 'admin';
    email: string;
    name: string;
    phone: string | null;
    status: 'active' | 'inactive';
  }
  const users: NewUser[] = [
    { role: 'admin', email: ADMIN.email, name: ADMIN.name, phone: null, status: 'active' },
    ...FACULTY.map((f) => ({ role: 'faculty' as const, email: f.email, name: f.name, phone: f.phone, status: f.status })),
  ];

  interface NewStudent {
    sectionKey: string;
    sectionIndex: number;
    studentId: string;
    rollNo: string;
    name: string;
    email: string;
    status: 'active' | 'inactive';
    isDemo: boolean;
  }
  const students: NewStudent[] = [];
  const emailCounts = new Map<string, number>();
  let studentSeq = 1; // STU-2025-001 reserved for the demo student

  const uniqueStudentEmail = (name: string): string => {
    const base = nameSlug(name);
    const n = (emailCounts.get(base) ?? 0) + 1;
    emailCounts.set(base, n);
    return `${base}${n}@student.westin.edu`;
  };

  SECTIONS.forEach((section, si) => {
    ROSTER_NAMES.forEach((name, i) => {
      if (si === 0 && i === 0) {
        // Demo student (mockData.student) takes the first slot of CSE-AIML 3A.
        students.push({
          sectionKey: section.key,
          sectionIndex: si,
          studentId: DEMO_STUDENT.studentId,
          rollNo: `${section.rollPrefix}001`,
          name: DEMO_STUDENT.name,
          email: DEMO_STUDENT.email,
          status: 'active',
          isDemo: true,
        });
        return;
      }
      const studentId = `STU-2025-${pad3(++studentSeq)}`;
      const email = uniqueStudentEmail(name);
      const status = INACTIVE_STUDENTS.has(name) ? 'inactive' : 'active';
      students.push({ sectionKey: section.key, sectionIndex: si, studentId, rollNo: `${section.rollPrefix}${pad3(i + 1)}`, name, email, status, isDemo: false });
    });
  });
  // Student user rows (demo student included — it lives in `students[0]`).
  users.push(
    ...students.map((s) => ({ role: 'student' as const, email: s.email, name: s.name, phone: null, status: s.status })),
  );

  const placements = buildTimetable();

  /* ---- 2. Upload storage objects (before the DB tx; upsert = re-runnable) ---- */

  console.log('Uploading study materials + report attachments to Supabase Storage ...');
  for (const f of STUDY_FILES) {
    await uploadObject(BUCKET_STUDY, `seed-${slugify(f.name)}.${f.type}`, fileBytes(f.name, f.type), FILE_CONTENT_TYPES[f.type]);
  }
  for (const r of REPORTS) {
    await uploadObject(BUCKET_REPORTS, r.fileName, fileBytes(r.fileName, r.fileType), FILE_CONTENT_TYPES[r.fileType]);
  }

  /* ---- 3. One transaction for all inserts ---- */

  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let demoPresent = 0;
  let demoTotal = 0;
  const client = await pool.connect();
  try {
    await client.query('begin');

    await client.query(`
      truncate table
        users, faculty_profiles, admin_profiles, student_profiles, sections, subjects,
        faculty_subjects, rooms, timetable_slots, attendance_sessions, attendance_records,
        study_files, events, announcements, daily_reports, user_settings, login_logs,
        refresh_tokens, otp_codes
      restart identity cascade
    `);
    console.log('Truncated all data tables.');

    // users
    const userRows = await insertMany(
      client, 'users',
      ['role', 'email', 'password_hash', 'display_name', 'phone', 'status'],
      users.map((u) => [u.role, u.email, u.role === 'student' ? passwordHash : null, u.name, u.phone, u.status]),
      'id, email',
    );
    const userIdByEmail = new Map<string, string>(userRows.map((r) => [String(r.email), String(r.id)]));

    const adminUserId = userIdByEmail.get(ADMIN.email)!;
    const facUser: Record<string, string> = {};
    for (const f of FACULTY) facUser[f.key] = userIdByEmail.get(f.email)!;

    // profiles
    await insertMany(client, 'admin_profiles', ['user_id', 'admin_id', 'title'], [[adminUserId, ADMIN.adminId, ADMIN.title]]);
    await insertMany(
      client, 'faculty_profiles',
      ['user_id', 'faculty_id', 'designation', 'department'],
      FACULTY.map((f) => [facUser[f.key], f.facultyId, f.designation, f.department]),
    );

    // sections / subjects / faculty_subjects / rooms
    const sectionRows = await insertMany(
      client, 'sections',
      ['label', 'department', 'year', 'class_teacher_id', 'max_strength'],
      SECTIONS.map((s) => [s.label, s.department, s.year, facUser[s.classTeacher], 40]),
      'id, label',
    );
    const sectionIdByKey = new Map<string, string>(sectionRows.map((r) => [String(r.label), String(r.id)]));
    const sectionId = (key: string) => sectionIdByKey.get(SECTIONS.find((s) => s.key === key)!.label)!;

    const subjectRows = await insertMany(client, 'subjects', ['name', 'code'], SUBJECTS.map((s) => [s.name, s.code]), 'id, code');
    const subjectIdByKey = new Map<string, string>(subjectRows.map((r) => [String(r.code), String(r.id)]));
    const subjectId = (key: string) => subjectIdByKey.get(SUBJECTS.find((s) => s.key === key)!.code)!;

    await insertMany(
      client, 'faculty_subjects',
      ['faculty_id', 'subject_id'],
      [...Object.entries(SUBJECT_FACULTY).map(([sk, fk]) => [facUser[fk], subjectId(sk)]), ...EXTRA_FACULTY_SUBJECTS.map(([fk, sk]) => [facUser[fk], subjectId(sk)])],
    );

    const roomRows = await insertMany(client, 'rooms', ['name'], ROOM_NAMES.map((n) => [n]), 'id, name');
    const roomIdByName = new Map<string, string>(roomRows.map((r) => [String(r.name), String(r.id)]));

    // timetable
    await insertMany(
      client, 'timetable_slots',
      ['section_id', 'day', 'start_time', 'end_time', 'subject_id', 'faculty_id', 'room_id'],
      placements.map((p) => [
        sectionId(p.sectionKey), p.day, PERIODS[p.pi].start, PERIODS[p.pi].end,
        subjectId(p.subjectKey), facUser[p.facultyKey], roomIdByName.get(p.roomName)!,
      ]),
    );
    console.log(`Inserted timetable: ${placements.length} slots.`);

    // student profiles
    await insertMany(
      client, 'student_profiles',
      ['user_id', 'student_id', 'section_id', 'year', 'department', 'roll_no'],
      students.map((s) => [
        userIdByEmail.get(s.email)!, s.studentId, sectionId(s.sectionKey), 3,
        SECTIONS.find((sec) => sec.key === s.sectionKey)!.department, s.rollNo,
      ]),
    );

    /* ---- attendance: last 60 days, skipping Sundays ---- */
    interface NewSession {
      sectionKey: string;
      sectionIndex: number;
      dateISO: string;
      pi: number;
      subjectKey: string;
      facultyKey: string;
      dayIndex: number;
      sessionIndex: number;
    }
    const slotsBySectionDay = new Map<string, Placement[]>();
    for (const p of placements) {
      const k = `${p.sectionKey}|${p.day}`;
      const list = slotsBySectionDay.get(k) ?? [];
      list.push(p);
      slotsBySectionDay.set(k, list);
    }
    for (const list of slotsBySectionDay.values()) list.sort((a, b) => a.pi - b.pi);

    const sessions: NewSession[] = [];
    for (let dayIndex = 0; dayIndex < 60; dayIndex++) {
      const dateISO = addDaysISO(TODAY, dayIndex - 59);
      const wd = weekdayOf(dateISO);
      if (wd === 0) continue; // skip Sundays
      const day = wd - 1; // 0=Mon..5=Sat
      SECTIONS.forEach((section, si) => {
        const list = slotsBySectionDay.get(`${section.key}|${day}`) ?? [];
        if (list.length === 0) return;
        const count = (dayIndex + si) % 3 === 0 ? 3 : 2; // 2-3 sessions/day
        const offset = dayIndex % list.length;
        for (let i = 0; i < count; i++) {
          const slot = list[(offset + i) % list.length];
          sessions.push({
            sectionKey: section.key, sectionIndex: si, dateISO, pi: slot.pi,
            subjectKey: slot.subjectKey, facultyKey: slot.facultyKey, dayIndex, sessionIndex: i,
          });
        }
      });
    }

    const sessionRows = await insertMany(
      client, 'attendance_sessions',
      ['section_id', 'subject_id', 'session_date', 'period', 'marked_by'],
      sessions.map((s) => [sectionId(s.sectionKey), subjectId(s.subjectKey), s.dateISO, PERIODS[s.pi].id, facUser[s.facultyKey]]),
      'id, section_id, to_char(session_date, \'YYYY-MM-DD\') as d, period',
    );
    const sessionIdByKey = new Map<string, string>(
      sessionRows.map((r) => [`${r.section_id}|${r.d}|${r.period}`, String(r.id)]),
    );

    // students per section (ordered) for record generation
    const studentsBySection = new Map<string, NewStudent[]>();
    for (const s of students) {
      const list = studentsBySection.get(s.sectionKey) ?? [];
      list.push(s);
      studentsBySection.set(s.sectionKey, list);
    }

    // Deterministic status: (studentIndex*7 + dayIndex*3 + sessionIndex) % 24
    //  -> 21/24 present (~87.5%), 2/24 absent (~8.3%), 1/24 leave (~4.2%).
    const demoStudentUser = userIdByEmail.get(DEMO_STUDENT.email)!;
    const recordRows: unknown[][] = [];
    for (const s of sessions) {
      const sessionId = sessionIdByKey.get(`${sectionId(s.sectionKey)}|${s.dateISO}|${PERIODS[s.pi].id}`)!;
      (studentsBySection.get(s.sectionKey) ?? []).forEach((student, stIndex) => {
        const r = (stIndex * 7 + s.dayIndex * 3 + s.sessionIndex) % 24;
        const status: 'present' | 'absent' | 'leave' = r < 21 ? 'present' : r < 23 ? 'absent' : 'leave';
        const studentUser = userIdByEmail.get(student.email)!;
        recordRows.push([sessionId, studentUser, status]);
        if (student.isDemo) {
          demoTotal++;
          if (status === 'present') demoPresent++;
        }
      });
    }
    await insertMany(client, 'attendance_records', ['session_id', 'student_id', 'status'], recordRows);
    console.log(`Inserted attendance: ${sessions.length} sessions, ${recordRows.length} records.`);

    // study files
    await insertMany(
      client, 'study_files',
      ['name', 'subject_id', 'file_type', 'size_bytes', 'storage_path', 'description', 'uploaded_by', 'created_at'],
      STUDY_FILES.map((f) => [
        f.name, subjectId(f.subject), f.type, parseSize(f.size), `seed-${slugify(f.name)}.${f.type}`,
        f.description, facUser[f.uploadedBy], istStamp(addDaysISO(TODAY, f.dayOffset), '10:00:00'),
      ]),
    );

    // events
    await insertMany(
      client, 'events',
      ['title', 'category', 'start_date', 'end_date', 'event_time', 'location', 'is_live', 'created_by'],
      EVENTS.map((e) => [
        e.title, e.category, addDaysISO(TODAY, e.dayOffset), e.endDayOffset === null ? null : addDaysISO(TODAY, e.endDayOffset),
        e.time, e.location, e.isLive, e.createdBy === 'admin' ? adminUserId : facUser[e.createdBy],
      ]),
    );

    // announcements
    await insertMany(
      client, 'announcements',
      ['title', 'message', 'category', 'audience', 'created_at'],
      ANNOUNCEMENTS.map((a) => [a.title, a.message, a.category, 'all', istStamp(addDaysISO(TODAY, a.dayOffset), `${String(a.hour).padStart(2, '0')}:00:00`)]),
    );

    // daily reports
    await insertMany(
      client, 'daily_reports',
      ['faculty_id', 'section_id', 'subject_id', 'report_date', 'topic', 'attachment_path'],
      REPORTS.map((r) => [facUser[r.faculty], sectionId(r.section), subjectId(r.subject), addDaysISO(TODAY, r.dayOffset), r.topic, r.fileName]),
    );

    // login logs
    const loginRows: unknown[][] = [];
    for (const l of TEACHER_LOGS) {
      const faculty = FACULTY.find((f) => f.name === l.name)!;
      loginRows.push([facUser[faculty.key], l.device, l.ip, istStamp(addDaysISO(TODAY, l.dayOffset), to24h(l.time))]);
    }
    for (const l of STUDENT_LOGS) {
      const student = students.find((s) => s.name === l.name && s.sectionKey === l.section)!;
      loginRows.push([userIdByEmail.get(student.email)!, l.device, l.ip, istStamp(addDaysISO(TODAY, l.dayOffset), to24h(l.time))]);
    }
    await insertMany(client, 'login_logs', ['user_id', 'device', 'ip', 'created_at'], loginRows);

    // default settings for demo users
    await insertMany(
      client, 'user_settings',
      ['user_id', 'push', 'email', 'announcements', 'reminders', 'theme'],
      [demoStudentUser, facUser['fac-004'], adminUserId].map((uid) => [uid, true, true, true, true, 'light']),
    );

    // Final safety check: no timetable conflicts.
    const conflicts = await client.query(`
      select count(*)::int as n from timetable_slots a
      join timetable_slots b on a.id < b.id
        and a.day = b.day
        and a.start_time < b.end_time and b.start_time < a.end_time
        and (a.room_id = b.room_id or a.faculty_id = b.faculty_id or a.section_id = b.section_id)
    `);
    if (conflicts.rows[0].n > 0) {
      throw new Error(`timetable has ${conflicts.rows[0].n} conflicts — aborting`);
    }

    await client.query('commit');
    console.log('Transaction committed.');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  /* ---- 4. Summary ---- */

  const tables = [
    'users', 'faculty_profiles', 'admin_profiles', 'student_profiles', 'sections', 'subjects',
    'faculty_subjects', 'rooms', 'timetable_slots', 'attendance_sessions', 'attendance_records',
    'study_files', 'events', 'announcements', 'daily_reports', 'user_settings', 'login_logs',
    'refresh_tokens', 'otp_codes',
  ];
  const counts = await pool.query(
    tables.map((t) => `select '${t}' as t, count(*)::int as n from ${t}`).join(' union all '),
  );
  await pool.end();

  console.log('\n================ Seed complete ================');
  const demoPct = demoTotal ? Math.round((demoPresent / demoTotal) * 100) : 0;
  console.log(`Timetable: ${placements.length} slots, conflict-free (verified).`);
  console.log(`Demo student attendance: ${demoPct}% present (${demoPresent}/${demoTotal} sessions).`);
  console.log('\nRow counts:');
  for (const row of counts.rows) console.log(`  ${String(row.t).padEnd(20)} ${row.n}`);
  console.log('\nDemo credentials (student password: Password@123; faculty/admin: OTP only)');
  console.log('  ----------------------------------------------- ------------------------------');
  console.log(`  Student   ${DEMO_STUDENT.studentId} (${DEMO_STUDENT.name})`.padEnd(55) + DEMO_STUDENT.email);
  console.log(`  Faculty   FAC-2025-014 (Dr. Priya Sharma)`.padEnd(55) + 'priya.sharma@westin.edu');
  console.log(`  Admin     ADM-2025-002 (Ananya Verma)`.padEnd(55) + 'ananya.verma@westin.edu');
  console.log('  ----------------------------------------------- ------------------------------');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
