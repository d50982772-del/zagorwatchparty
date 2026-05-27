interface Props {
  count: number;
}

export default function UsersCounter({ count }: Props) {
  return (
    <div className="users-counter" title="Підключені користувачі">
      <span className="users-counter__dot" />
      <span>{count}</span>
    </div>
  );
}
