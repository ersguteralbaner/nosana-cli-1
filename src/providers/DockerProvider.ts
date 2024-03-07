import chalk from 'chalk';
import { Operation, Provider, OpState, Flow } from './Provider';
import Docker from 'dockerode';
import stream from 'stream';
import { parse } from 'shell-quote';
import { BasicProvider } from './BasicProvider';

export class DockerProvider extends BasicProvider implements Provider {
  private docker: Docker;
  protected supportedOps: { [key: string]: string } = {
    'container/run': this.runOperation.name,
  };

  constructor(podman: string) {
    super();
    const podmanUri = new URL(
      podman.startsWith('http') || podman.startsWith('ssh')
        ? podman
        : `http://${podman}`,
    );
    const protocol = podmanUri.protocol.replace(':', '');
    if (
      !['https', 'http', 'ssh'].includes(protocol) &&
      typeof protocol !== 'undefined'
    ) {
      throw new Error(`Protocol ${protocol} not supported`);
    }

    this.docker = new Docker({
      host: podmanUri.hostname,
      port: podmanUri.port,
      protocol: protocol as 'https' | 'http' | 'ssh' | undefined,
    });
  }

  /**
   * Check if DockerProvider is healthy by checking if podman is running
   * @returns boolean
   */
  public async healthy(throwError: Boolean = true): Promise<Boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch (error) {
      if (throwError) {
        throw error;
      }
      console.error(error);
      return false;
    }
  }

  /**
   * Run operation and return results
   * @param op Operation specs
   * @returns OpState
   */
  private async runOperation(
    op: Operation<'container/run'>,
    flowId: string,
  ): Promise<OpState> {
    const startTime = Date.now();
    let run: { logs: OpState['logs']; exitCode: number } = {
      logs: [],
      exitCode: 0,
    };

    const updateOpState: Partial<OpState> = {
      startTime,
      endTime: null,
      status: 'running',
    };
    const opStateIndex = this.db.data.flows[flowId].state.opStates.findIndex(
      (opState) => op.id === opState.operationId,
    );
    this.db.data.flows[flowId].state.opStates[opStateIndex] = {
      ...this.db.data.flows[flowId].state.opStates[opStateIndex],
      ...updateOpState,
    };
    this.db.write();

    try {
      const cmd = op.args?.cmds;
      run = await this.executeCmd(cmd, op.args.image, flowId, opStateIndex);
      updateOpState.status = run.exitCode ? 'failed' : 'success';
      updateOpState.exitCode = run.exitCode;
    } catch (e: any) {
      updateOpState.status = 'failed';
      run.logs.push({
        type: 'stderr' as const,
        log: e.toString(),
      });
    }

    updateOpState.logs = run?.logs;
    updateOpState.endTime = Date.now();
    this.db.data.flows[flowId].state.opStates[opStateIndex] = {
      ...this.db.data.flows[flowId].state.opStates[opStateIndex],
      ...updateOpState,
    };
    this.db.write();

    return this.db.data.flows[flowId].state.opStates[opStateIndex];
  }

  /**
   * Pull docker image
   * @param image
   * @returns
   */
  private async pullImage(image: string) {
    return await new Promise((resolve, reject): any =>
      this.docker.pull(image, (err: any, stream: any) => {
        this.docker.modem.followProgress(stream, onFinished);
        function onFinished(err: any, output: any) {
          if (!err) {
            resolve(true);
            return;
          }
          reject(err);
        }
      }),
    );
  }

  /**
   * Perform docker.run for given cmd, return logs
   * @param cmd
   * @param image
   * @param flowStateIndex
   * @param opIndex
   * @returns
   */
  private async executeCmd(
    cmds: string[],
    image: string,
    flowId: string,
    opStateIndex: number,
  ): Promise<{
    exitCode: number;
    logs: OpState['logs'];
  }> {
    let cmd = '';
    for (let i = 0; i < cmds.length; i++) {
      if (i === 0) {
        cmd += cmds[i];
      } else {
        cmd += "'" + cmds[i] + "'";
      }
    }
    const parsedcmd = parse(cmd);

    try {
      await this.pullImage(image);
    } catch (error: any) {
      chalk.red(console.log('Cannot pull image', { error }));
      return {
        exitCode: 2,
        logs: [
          {
            type: 'stderr',
            log: error.message.toString(),
          },
        ] as OpState['logs'],
      };
    }

    const name =
      image +
      '-' +
      [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    this.db.data.flows[flowId].state.opStates[opStateIndex].providerId = name;
    this.db.write();

    const stdoutStream = new stream.PassThrough();
    const stderrStream = new stream.PassThrough();

    stdoutStream.on('data', (chunk) => {
      this.eventEmitter.emit('newLog', { opStateIndex, log: chunk.toString() });
      this.db.data.flows[flowId].state.opStates[opStateIndex].logs.push({
        type: 'stdout',
        log: chunk.toString(),
      });
      this.db.write();
    });

    return await this.docker
      .run(image, parsedcmd as string[], [stdoutStream, stderrStream], {
        name,
        Tty: false,
        // --gpus all
        HostConfig: {
          DeviceRequests: [
            {
              Count: -1,
              Driver: 'nvidia',
              Capabilities: [['gpu']],
            },
          ],
        },
      })
      .then(([res, container]) => {
        const stderr = stderrStream.read() as Buffer | undefined;
        const logs = this.db.data.flows[flowId].state.opStates[opStateIndex].logs;
        if (stderr) {
          logs.push({
            type: 'stderr',
            log: stderr.toString(),
          });
        }

        return {
          exitCode: res.StatusCode,
          logs,
        };
      })
      .catch((error) => {
        chalk.red(console.log('Docker run failed', { error }));
        // TODO: document error codes
        return {
          exitCode: 1,
          logs: [
            {
              type: 'stderr',
              log: error.message.toString(),
            },
          ] as OpState['logs'],
        };
      });
  }

  public async clearFlow(flowId: string): Promise<void> {
    const flow = this.db.data.flows[flowId];
    // for every op in flow, stop & remove container
    for (let j = 0; j < flow.state.opStates.length; j++) {
      const op = flow.state.opStates[j];
      if (op.providerId) {
        try {
          const c = await this.getContainerByName(op.providerId);
          if (c) {
            const container = this.docker.getContainer(c.Id);
            const containerInfo = await container.inspect();
            if (containerInfo.State.Running) {
              await container.stop();
            }
            await container.remove();
          }
        } catch (err: any) {
          console.error(`couldnt stop container ${op.providerId} - ${err}`);
        }
      }
    }
    super.clearFlow(flowId);
  }

  public async continueFlow(flowId: string): Promise<Flow> {
    const flow: Flow | undefined = this.getFlow(flowId);
    if (!flow) throw new Error(`Flow ${flowId} does not exist`);
    if (flow.state.endTime)
      throw new Error(`Flow already finished at ${flow.state.endTime}`);

    for (let i = 0; i < flow.jobDefinition.ops.length; i++) {
      const op = flow.jobDefinition.ops[i];
      const opState = flow.state.opStates.find((o) => o.operationId === op.id);
      if (opState) {
        if (
          opState.providerId &&
          !opState.endTime &&
          op.type === 'container/run'
        ) {
          await new Promise<void>(async (resolve, reject) => {
            const c = await this.getContainerByName(
              opState.providerId as string,
            );

            // when node is shutted down before the container started, it won't find the container
            // run op again in new container
            if (!c) {
              try {
                await this.runOperation(
                  op as Operation<'container/run'>,
                  flowId,
                );
              } catch (error) {
                flow.state.opStates[i].status = 'failed';
                this.db.write();
              }
              resolve();
            } else {
              const container = this.docker.getContainer(c.Id);
              const containerInfo = await container.inspect();

              // Create streams and wait for it to finish
              if (containerInfo.State.Running) {
                const stdoutStream = new stream.PassThrough();
                const stderrStream = new stream.PassThrough();
                flow.state.opStates[i].logs = [];

                stdoutStream.on('data', (chunk) => {
                  this.eventEmitter.emit('newLog', {
                    type: 'stdout',
                    log: chunk.toString(),
                  });
                  flow.state.opStates[i].logs.push({
                    type: 'stdout',
                    log: chunk.toString(),
                  });
                });

                const logStream = await container.logs({
                  stdout: true,
                  stderr: true,
                  follow: true,
                });
                container.modem.demuxStream(
                  logStream,
                  stdoutStream,
                  stderrStream,
                );

                logStream.on('end', async () => {
                  const endInfo = await container.inspect();
                  flow.state.opStates[i].exitCode = endInfo.State.ExitCode;
                  flow.state.opStates[i].status = endInfo.State.ExitCode
                    ? 'failed'
                    : 'success';
                  flow.state.opStates[i].endTime = Math.floor(
                    new Date(endInfo.State.FinishedAt).getTime(),
                  );
                  this.db.write();

                  stdoutStream.end();
                  resolve();
                });
              } else if (containerInfo.State.Status === 'exited') {
                // op is done, get logs from container and save them in the flow
                const log = await container.logs({
                  follow: false,
                  stdout: true,
                  stderr: true,
                });

                // parse output
                const output = this.demuxOutput(log);
                flow.state.opStates[i].logs = [];
                this.db.write();

                if (output.stdout !== '') {
                  flow.state.opStates[i].logs.push({
                    type: 'stdout',
                    log: output.stdout,
                  });
                }
                if (output.stderr !== '') {
                  flow.state.opStates[i].logs.push({
                    type: 'stderr',
                    log: output.stderr,
                  });
                }

                flow.state.opStates[i].exitCode = containerInfo.State.ExitCode;
                flow.state.opStates[i].status = containerInfo.State.ExitCode
                  ? 'failed'
                  : 'success';
                flow.state.opStates[i].endTime = Math.floor(
                  new Date(containerInfo.State.FinishedAt).getTime(),
                );
                this.db.write();
                resolve();
              }
            }
          });
        } else if (!opState.endTime && op.type === 'container/run') {
          let state;
          try {
            state = await this.runOperation(
              op as Operation<'container/run'>,
              flowId,
            );
          } catch (error) {
            console.log(chalk.red(error));
            flow.state.opStates[i].status = 'failed';
            this.db.write();
            break;
          }
          if (state && state.status === 'failed') break;
        }
      } else {
        // op not found
        if (!flow.state.errors) {
          flow.state.errors = [];
        }
        flow.state.errors.push(`Cannot find state of op ${op.id}`);
      }
    }

    this.finishFlow(flowId);
    return flow;
  }

  /****************
   *   Getters   *
   ****************/
  private async getContainerByName(
    name: string,
  ): Promise<Docker.ContainerInfo | undefined> {
    const opts = {
      limit: 1,
      filters: `{"name": ["${name}"]}`,
    };

    return new Promise(async (resolve, reject) => {
      await this.docker.listContainers(opts, (err, containers) => {
        if (err) {
          reject(err);
        } else {
          resolve(containers && containers[0]);
        }
      });
    });
  }

  /****************
   *   Helpers   *
   ****************/
  /**
   * input: log Buffer, output stdout & stderr strings
   * @param buffer
   * @returns
   */
  private demuxOutput = (
    buffer: Buffer,
  ): { stdout: string; stderr: string } => {
    const stdouts: Buffer[] = [];
    const stderrs: Buffer[] = [];

    function bufferSlice(end: number) {
      const out = buffer.slice(0, end);
      buffer = Buffer.from(buffer.slice(end, buffer.length));
      return out;
    }

    while (buffer.length > 0) {
      const header = bufferSlice(8);
      const nextDataType = header.readUInt8(0);
      const nextDataLength = header.readUInt32BE(4);
      const content = bufferSlice(nextDataLength);
      switch (nextDataType) {
        case 1:
          stdouts.push(content);
          break;
        case 2:
          stderrs.push(content);
          break;
        default:
        // ignore
      }
    }

    return {
      stdout: Buffer.concat(stdouts).toString('utf8'),
      stderr: Buffer.concat(stderrs).toString('utf8'),
    };
  };
}