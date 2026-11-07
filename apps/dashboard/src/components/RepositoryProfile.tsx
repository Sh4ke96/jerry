import type { ProjectProfile } from '@jerry/contracts';
import { EMOJI } from '@jerry/contracts/emoji';
import { defineComponent, type PropType } from 'vue';
import { ATTENTION } from '../lib/classes';
import { Emoji } from './Emoji';
import { Fact, Facts } from './Facts';
import { StatusBadge } from './StatusBadge';

/** Languages and frameworks, the way a person names a stack. */
export function stackText(profile: ProjectProfile | null, languages = 5): string {
  if (profile === null) return '';
  return [...profile.languages.slice(0, languages).map((language) => language.name), ...profile.frameworks.map((framework) => framework.name)].join(', ');
}

/** The project's commands as they run on this machine, with runners that are not installed. */
export const ProfileCommands = defineComponent({
  name: 'ProfileCommands',
  props: { profile: { type: Object as PropType<ProjectProfile>, required: true } },
  setup(props) {
    return () => (
      <div class="grid gap-1">
        {props.profile.commands.length === 0
          ? 'none found'
          : props.profile.commands.map((command) => (
              <div key={`${command.kind}${command.run}`} class="flex flex-wrap items-center gap-2">
                <StatusBadge>{command.kind}</StatusBadge> <code class="font-mono text-xs break-all">{command.run}</code>
              </div>
            ))}
        {props.profile.environment.missingRunners.length > 0 && (
          <div class={['mt-1', ATTENTION]}>
            <Emoji symbol={EMOJI.warning} />
            Not installed: {props.profile.environment.missingRunners.join(', ')}
          </div>
        )}
      </div>
    );
  },
});

/** Everything JERRY detected in a repository: stack, commands, CI, schemas, instructions and suspicious text. */
export const RepositoryProfileFacts = defineComponent({
  name: 'RepositoryProfileFacts',
  props: { profile: { type: Object as PropType<ProjectProfile>, required: true } },
  setup(props) {
    return () => {
      const profile = props.profile;
      return (
        <Facts>
          <Fact label="Stack">{stackText(profile) || 'unknown'}</Fact>
          <Fact label="Commands">
            <ProfileCommands profile={profile} />
          </Fact>
          {profile.ci.length > 0 && <Fact label="CI">{profile.ci.map((entry) => entry.path).join(', ')}</Fact>}
          {profile.apiSchemas.length > 0 && <Fact label="API schemas">{profile.apiSchemas.map((entry) => `${entry.path} (${entry.kind})`).join(', ')}</Fact>}
          {profile.migrations.length > 0 && <Fact label="Migrations">{profile.migrations.map((entry) => `${entry.path} (${entry.kind}, ${entry.files})`).join(', ')}</Fact>}
          <Fact label="Docs">{profile.docs.length} indexed</Fact>
          <Fact label="Instructions">
            {profile.instructions.length === 0
              ? 'none'
              : profile.instructions.map((entry) => (
                  <div key={entry.path}>
                    <code class="font-mono text-xs">{entry.path}</code> <span class="text-muted-foreground">{entry.role}</span>
                    {entry.notes.length > 0 && <span class={ATTENTION}> · {entry.notes.join('; ')}</span>}
                  </div>
                ))}
          </Fact>
          <Fact label="Suspicious text">
            {profile.injection.findings.length === 0 ? (
              'none found'
            ) : (
              <ul class="grid gap-1.5">
                {profile.injection.findings.slice(0, 20).map((finding) => (
                  <li key={`${finding.path}:${finding.line}`} class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <code class="font-mono text-xs">
                      {finding.path}:{finding.line}
                    </code>{' '}
                    <StatusBadge tone="warn" emoji={EMOJI.warning}>
                      {finding.rule}
                    </StatusBadge>{' '}
                    <span class="text-muted-foreground">{finding.excerpt}</span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
        </Facts>
      );
    };
  },
});
