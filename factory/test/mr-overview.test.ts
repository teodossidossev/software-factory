// The overview of one merge request (src/mr-overview.ts, SF-209): SonarQube's comment parsed (the
// "N New issues" format, the older "Bugs / Vulnerabilities / Code Smells" one, a passed gate, a
// failed gate without counts, the newest comment winning, only http(s) links), ready and the
// reasons (conflicts, a draft, approvals, behind, the host undecided), and the comment counts; the
// bot rule; mergeRequestOverview's two reads of a fake forge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MergeRequestStatus } from '../src/forge.js';
import type { ReviewComment, ReviewThread } from '../src/forge-comments.js';
import { isBotAuthor, isBotComment, mergeRequestOverview, overviewOf, parseSonar, sonarOf } from '../src/mr-overview.js';

const NEW_FORMAT = [
  '## ![Quality Gate Failed](https://sonarsource.github.io/static/qg-failed-20px.png \'Quality Gate Failed\') **Quality Gate failed**',
  '',
  'Failed conditions  ',
  '![](https://sonarsource.github.io/static/failed-16px.png \'\') [61.5% Coverage on New Code](https://sonarcloud.io/component_measures?id=app&pullRequest=4) (required ≥ 80%)  ',
  '',
  'Issues  ',
  '![](https://sonarsource.github.io/static/passed-16px.png \'\') [3 New issues](https://sonarcloud.io/project/issues?id=app&pullRequest=4&sinceLeakPeriod=true)  ',
  '![](https://sonarsource.github.io/static/accepted-16px.png \'\') [0 Accepted issues](https://sonarcloud.io/project/issues?id=app&pullRequest=4&issueStatuses=ACCEPTED)',
  '',
  '[See analysis details on SonarCloud](https://sonarcloud.io/dashboard?id=app&pullRequest=4)',
].join('\n');

const OLDER_FORMAT = [
  'SonarQube Quality Gate',
  '[![Quality Gate failed](https://sonar.example/static/failed.png \'Quality Gate failed\')](https://sonar.example/dashboard?id=app&pullRequest=4) **Quality Gate failed**',
  '[![Bug](https://sonar.example/static/bug.png \'Bug\')](https://sonar.example/issues?types=BUG) [2 Bugs](https://sonar.example/issues?types=BUG)',
  '[![Vulnerability](https://sonar.example/static/vul.png \'Vulnerability\')](https://sonar.example/issues?types=VULNERABILITY) [1 Vulnerability](https://sonar.example/issues?types=VULNERABILITY)',
  '[![Code Smell](https://sonar.example/static/smell.png \'Code Smell\')](https://sonar.example/issues?types=CODE_SMELL) [5 Code Smells](https://sonar.example/issues?types=CODE_SMELL)',
  '[See analysis details on SonarQube](https://sonar.example/dashboard?id=app&pullRequest=4)',
].join('\n');

const PASSED = '## ![Quality Gate Passed](https://sonarsource.github.io/static/qg-passed-20px.png \'Quality Gate Passed\') **Quality Gate passed**\n\nIssues\n[0 New issues](https://sonarcloud.io/project/issues?id=app)\n\n[See analysis details on SonarCloud](https://sonarcloud.io/dashboard?id=app)';

const comment = (body: string, created_at: string, bot = true, author = 'sonarcloud[bot]'): ReviewComment => ({ author, body, created_at, bot });
const thread = (id: string, comments: ReviewComment[], resolved: boolean | null = null): ReviewThread => ({ id, resolved, path: null, line: null, comments });
const status = (fields: Partial<MergeRequestStatus> = {}): MergeRequestStatus => ({ number: 4, url: 'https://git.example/4', state: 'open', draft: false, mergeable: true, ...fields });

test('parseSonar: the "N New issues" format with its link, the older format summed with the analysis link, a failed gate without counts', () => {
  assert.deepEqual(parseSonar(NEW_FORMAT), { gate_failed: true, new_issues: 3, url: 'https://sonarcloud.io/project/issues?id=app&pullRequest=4&sinceLeakPeriod=true' });
  assert.deepEqual(parseSonar(OLDER_FORMAT), { gate_failed: true, new_issues: 8, url: 'https://sonar.example/dashboard?id=app&pullRequest=4' });
  assert.deepEqual(parseSonar('Quality Gate failed: the coverage is too low.'), { gate_failed: true, new_issues: null, url: null });
  assert.deepEqual(parseSonar(PASSED), { gate_failed: false, new_issues: 0, url: 'https://sonarcloud.io/project/issues?id=app' });
  // Only an http(s) link: a javascript: target is refused, and the next kind of link is taken.
  assert.equal(parseSonar('Quality Gate failed [3 New issues](javascript:alert(1)) [analysis details](https://sonar.example/d)').url, 'https://sonar.example/d');
  assert.equal(parseSonar('Quality Gate failed [3 New issues](javascript:alert(1)) [analysis details](data:text/html,x)').url, null);
});

test('sonarOf: only a problem is said; the newest SonarQube comment of every thread wins; none without a SonarQube comment', () => {
  assert.equal(sonarOf([]), null);
  assert.equal(sonarOf([thread('a', [comment('Looks good.', '2026-11-09T10:00:00Z', false, 'alice')])]), null);
  // A passed gate with no new issue: nothing.
  assert.equal(sonarOf([thread('a', [comment(PASSED, '2026-11-09T10:00:00Z')])]), null);
  // A passed gate with new issues: said.
  assert.deepEqual(sonarOf([thread('a', [comment('Quality Gate passed\n2 New issues', '2026-11-09T10:00:00Z')])]), { gate_failed: false, new_issues: 2, url: null });
  const failed = thread('a', [comment(NEW_FORMAT, '2026-11-09T10:00:00Z')]);
  const passedLater = thread('b', [comment(PASSED, '2026-11-09T11:00:00Z')]);
  assert.equal(sonarOf([failed, passedLater]), null);
  const failedLater = thread('c', [comment(NEW_FORMAT, '2026-11-09T12:00:00Z')]);
  assert.equal(sonarOf([passedLater, failedLater])?.new_issues, 3);
  // A human's comment quoting the gate is no SonarQube comment.
  assert.equal(sonarOf([thread('d', [comment('Quality Gate failed, I saw it', '2026-11-09T13:00:00Z', false, 'alice')])]), null);
});

test('the bot rule: flagged by the host, a [bot] login, the word bot, sonar; a SonarQube body makes any author\'s comment a bot\'s', () => {
  assert.deepEqual(['deployer', 'sonarcloud[bot]', 'project_12_bot_ab12', 'ci-bot', 'Bot', 'SonarQube', 'abbott', 'robot', 'bottle', 'alice'].map((name) => isBotAuthor(name, false)),
    [false, true, true, true, true, true, false, false, false, false]);
  assert.equal(isBotAuthor('deployer', true), true);
  assert.equal(isBotComment('carol', false, 'Quality Gate failed, see SonarQube'), true);
  assert.equal(isBotComment('carol', false, 'The quality gate passed.'), false);
  assert.equal(isBotComment('carol', false, 'Sonar is down'), false);
});

test('overviewOf: ready and the reasons (conflicts, a draft, approvals, behind, the host undecided), each once and the host\'s first; behind; the pipeline', () => {
  const ready = (fields: Partial<MergeRequestStatus>) => {
    const { ready: value, reasons, behind } = overviewOf(status(fields), []);
    return { ready: value, reasons, behind };
  };
  assert.deepEqual(ready({ behind: 0 }), { ready: true, reasons: [], behind: 0 });
  assert.deepEqual(ready({}), { ready: true, reasons: [], behind: null });
  // Conflicts: the host's words once.
  assert.deepEqual(ready({ mergeable: false, reason: 'it has conflicts with main', conflicts: true }), { ready: false, reasons: ['it has conflicts with main'], behind: null });
  assert.deepEqual(ready({ mergeable: false, reason: 'its pipeline must succeed first', conflicts: true }), {
    ready: false, reasons: ['its pipeline must succeed first', 'it has conflicts with the target branch'], behind: null,
  });
  // A draft: once.
  assert.deepEqual(ready({ mergeable: false, reason: 'it is a draft', draft: true }).reasons, ['it is a draft']);
  assert.deepEqual(ready({ mergeable: false, reason: 'its discussions are not resolved', draft: true }).reasons, ['its discussions are not resolved', 'it is a draft']);
  // Approvals: the host's own reason.
  assert.deepEqual(ready({ mergeable: false, reason: 'it needs approvals' }), { ready: false, reasons: ['it needs approvals'], behind: null });
  // Behind makes a mergeable one not ready, with its reason; the host's rebase reason stands alone.
  assert.deepEqual(ready({ behind: 3 }), { ready: false, reasons: ['it is 3 commits behind the target branch'], behind: 3 });
  assert.deepEqual(ready({ behind: 1 }).reasons, ['it is 1 commit behind the target branch']);
  assert.deepEqual(ready({ mergeable: false, reason: 'it must be rebased onto the target branch', behind: 2 }).reasons, ['it must be rebased onto the target branch']);
  assert.deepEqual(ready({ mergeable: false, reason: 'the branch is behind main, which must be up to date before merging', behind: 2 }).reasons.length, 1);
  // The host undecided: null, unless behind decides it.
  assert.deepEqual(ready({ mergeable: null, reason: 'GitLab is still checking whether it can be merged' }), {
    ready: null, reasons: ['GitLab is still checking whether it can be merged'], behind: null,
  });
  assert.equal(ready({ mergeable: null, behind: 1 }).ready, false);
  // A host that gives no reason: not ready without words.
  assert.deepEqual(ready({ mergeable: false }), { ready: false, reasons: [], behind: null });
  const pipeline = { state: 'failed' as const, text: 'failed', url: null };
  assert.deepEqual(overviewOf(status({ pipeline }), []).pipeline, pipeline);
  assert.equal(overviewOf(status(), []).pipeline, null);
});

test('overviewOf: the human and the bot comments of every thread, resolved ones too', () => {
  const threads = [
    thread('a', [comment('Rename it.', '1', false, 'alice'), comment('Done.', '2', false, 'bob')], false),
    thread('b', [comment('Typo.', '3', false, 'carol')], true),
    thread('c', [comment(PASSED, '4')]),
    thread('d', [comment('Deployed.', '5', true, 'deployer'), comment('Thanks.', '6', false, 'alice')]),
  ];
  assert.deepEqual(overviewOf(status(), threads).comments, { human: 4, bot: 2 });
  assert.deepEqual(overviewOf(status(), []).comments, { human: 0, bot: 0 });
});

test('mergeRequestOverview: the status and the threads of the number, read from the forge', async () => {
  const asked: string[] = [];
  const forge = {
    status: async (number: number) => {
      asked.push(`status ${number}`);
      return status({ number, behind: 0, pipeline: { state: 'passed' as const, text: 'success', url: 'https://git.example/p/1' } });
    },
    threads: async (number: number) => {
      asked.push(`threads ${number}`);
      return [thread('s', [comment(NEW_FORMAT, '2026-11-09T10:00:00Z')]), thread('h', [comment('Rename it.', '2026-11-09T10:05:00Z', false, 'alice')])];
    },
  };
  assert.deepEqual(await mergeRequestOverview(forge, 7), {
    number: 7, ready: true, reasons: [], behind: 0, pipeline: { state: 'passed', text: 'success', url: 'https://git.example/p/1' },
    sonar: { gate_failed: true, new_issues: 3, url: 'https://sonarcloud.io/project/issues?id=app&pullRequest=4&sinceLeakPeriod=true' },
    comments: { human: 1, bot: 1 },
  });
  assert.deepEqual(asked.sort(), ['status 7', 'threads 7']);
});
