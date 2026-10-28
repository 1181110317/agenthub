// An isolated test parent can exercise the real shutdown handlers on Windows,
// where ChildProcess.kill() uses TerminateProcess rather than delivering SIGTERM.
process.on('message', message => {
  if (message?.type === 'test.shutdown') process.emit('SIGTERM');
});
