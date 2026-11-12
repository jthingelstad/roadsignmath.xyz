// A moderator for tests: answers what the test sets, and remembers what it was asked.

import {
  ModeratorUnavailable,
  type Moderator,
  type Post,
  type PostVerdict,
  type ReportVerdict,
  type AvatarVerdict,
  type ProfileVerdict,
  type ProfileWords
} from '../../src/moderation/moderator.ts';

export class ScriptedModerator implements Moderator {
  post: PostVerdict | 'unavailable' = { verdict: 'ok', reason: '', alt: [] };
  report: ReportVerdict | 'unavailable' = { verdict: 'keep', reason: 'Nothing wrong with it.' };
  readonly posts: Post[] = [];
  readonly reports: { post: Post; reason: string }[] = [];
  avatar: AvatarVerdict | 'unavailable' = { verdict: 'ok', reason: '' };
  readonly avatars: Buffer[] = [];
  profile: ProfileVerdict | 'unavailable' = { verdict: 'ok', reason: '' };
  readonly profiles: ProfileWords[] = [];

  async reviewPost(post: Post): Promise<PostVerdict> {
    this.posts.push(post);
    if (this.post === 'unavailable') throw new ModeratorUnavailable('down');
    return this.post;
  }

  async reviewReport(post: Post, reason: string): Promise<ReportVerdict> {
    this.reports.push({ post, reason });
    if (this.report === 'unavailable') throw new ModeratorUnavailable('down');
    return this.report;
  }

  async reviewAvatar(photo: Buffer): Promise<AvatarVerdict> {
    this.avatars.push(photo);
    if (this.avatar === 'unavailable') throw new ModeratorUnavailable('down');
    return this.avatar;
  }

  async reviewProfile(words: ProfileWords): Promise<ProfileVerdict> {
    this.profiles.push(words);
    if (this.profile === 'unavailable') throw new ModeratorUnavailable('down');
    return this.profile;
  }
}
