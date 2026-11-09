import type { User } from '@hcl/contracts';

export function UserAvatar({
  user,
  className = 'avatar',
  alt = '',
}: {
  user: Pick<User, 'displayName' | 'username' | 'avatarUrl'>;
  className?: string;
  alt?: string;
}) {
  const name = user.displayName || user.username;
  if (user.avatarUrl)
    return <img className={`${className} avatar-image`} src={user.avatarUrl} alt={alt} />;
  return <span className={className}>{Array.from(name)[0]}</span>;
}
