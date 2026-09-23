---
"title": "build_hoomd_from_source"
"slug": "build_hoomd_from_source"
"pubDate": "2023-10-23T12:00:00+08:00"
"updatedDate": "2026-07-21T11:01:00+08:00"
"categories":
  - "计算机"
"tags":
  - "hoomd-blue"
  - "hoomd-rs"
---

## hoomd-rs

[`hoomd-rs`](https://hoomd-rs.readthedocs.io/) 是 `HOOMD-blue` 的精神继承者，也是一组用于粒子模拟及相关方法的 Rust 软件包（crates）。它支持对硬形状粒子以及具有各向同性或各向异性相互作用的粒子进行蒙特卡罗模拟，并为向量运算、几何基元、空间数据结构、能量计算以及模拟的其他组成部分提供公共 API。用户可以在自己的分析与模拟方法中复用这些组件。借助 `hoomd-rs`，用户可以创建实时交互式模拟可视化，在高性能计算资源上批量运行长时间模拟，并分析模拟结果。

## 非 root 用户安装 micromamba (optional)

`micromamba` 是一个 C++ 实现的 `conda` 替代品，使用方法基本与 `conda` 一致

直接运行命令安装 `micromamba`

```bash
"${SHELL}" <(curl -L micro.mamba.pm/install.sh)
```

如果遇到网络问题，可以尝试下载 `micro.mamba.pm/install.sh` 之后在 shell 中运行。

如果遇到网络问题，可以尝试按照默认的参数手动按顺序运行 `install.sh` 中的命令

创建文件夹

```bash
mkdir -p ~/.local/bin
```

把下载的 `micromamba` 移动到文件夹中

```bash
mv /path/to/downloaded/micromamba ~/.local/bin/
```

加上可执行权限

```bash
chmod +x ~/.local/bin/micromamba
```

init 操作

```bash
~/.local/bin/micromamba shell init
```

应该可以看到提示更新了 `~/.bashrc`

```bash
source ~/.bashrc
```

完成了安装，应该可以正常使用 `micromamba`

更新 `micromamba` 的命令：

```bash
micromamba self-update
```

## 新建环境 (optional)

如果没有环境的话，首先新建一个虚拟环境 (以 `hoomd7` 为例)

```bash
micromamba create -c conda-forge -n hoomd7
```

激活该虚拟环境

```bash
micromamba activate hoomd7
```

> 在过去的使用过程中，即使已经安装了 `mpich`，在 cmake 配置的阶段总是找不到 `mpicc`、`mpicxx` 之类的路径。
>
> `mpich` 可能存在一些问题，建议使用 `openmpi`，可以尝试在环境中删除 `mpich`，然后安装 `openmpi`

```bash
micromamba remove mpich
```

```bash
micromamba install -c conda-forge openmpi
```

## 从源码安装 HOOMD

`conda-forge` 提供 HOOMD-blue 的串行 CPU 和单 GPU 构建，日常单机使用通常无须自行编译。若需要 MPI 并行、多 GPU 运行，或者需要在高性能计算平台上链接系统原生的 MPI/CUDA 库，则需要从源码编译 HOOMD-blue。

> 在开始源码编译之前，建议先确认自己的需求。仅进行串行 CPU 或单 GPU 模拟时，直接安装 `conda-forge` 提供的二进制包通常更加方便；需要 MPI、多 GPU 或针对特定 HPC 环境进行优化时，再考虑从源码构建。

主要参考了 <https://hoomd-blue.readthedocs.io/en/latest/building.html> 的官方教程。

下载前置的包

```bash
micromamba install -c conda-forge cmake cereal eigen git python numpy pybind11 openmpi ninja -y
```

### 安装 HOOMD 本体

下载 HOOMD 源码，有两种方法，一种方法是使用 `git` (--recursive 是必要的)

```bash
git clone --recursive https://github.com/glotzerlab/hoomd-blue
```

如果之前已经 `git clone` 过了，可以拉取最新的源码

```bash
cd hoomd-blue
```

```bash
git pull --recurse-submodules
```

还有一种方法是直接在 <https://hoomd-blue.readthedocs.io/en/latest/building.html#obtain-the-source> 或者在 <https://github.com/glotzerlab/hoomd-blue/releases> 下载最新的打包好的源码。

```bash
wget https://github.com/glotzerlab/hoomd-blue/releases/download/v7.2.0/hoomd-7.2.0.tar.gz
```

解压缩

```bash
tar -zxvf hoomd-7.2.0.tar.gz
```

重命名，和上一种方法保持一致

```bash
mv hoomd-7.2.0 hoomd-blue
```

通过以上两种中的一种方式下载好源码之后，进入 `hoomd-blue` 文件夹

```bash
cd hoomd-blue
```

使用 `cmake` 进行 configure，[官方教程](https://hoomd-blue.readthedocs.io/en/latest/building.html) 有很多编译选项，这里只介绍用到的选项

- ENABLE_MPI：默认 off，on 开启
- ENABLE_GPU：默认 off，on 开启

> 以下选项可以让 CMake to optimize the build for your processor: -DCMAKE_CXX_FLAGS=-march=native -DCMAKE_C_FLAGS=-march=native

举例来说：

开启 MPI，不开启 GPU

```bash
cmake -B build -S . -GNinja -DENABLE_MPI=on -DENABLE_GPU=off
```

开启 MPI，开启 GPU

```bash
cmake -B build -S . -GNinja -DENABLE_MPI=on -DENABLE_GPU=on
```

configure 正常通过没有报错的话

```bash
cd build
```

可以使用 `ninja` 进行 build (其中 `-j8` 是并行编译的 CPU 核心的数量，可以省略，也可以根据机器的实际情况填写合适的参数)

```bash
ninja -j8
```

编译正常通过之后，使用 `ninja` 进行 install

```bash
ninja install
```

至此，从源码安装 HOOMD 告一段落。

### 测试 HOOMD 的 MPI 并行

#### 简易测试

创建 `mpi_test.py` 文件，内容如下

```python
import os
import hoomd
print(hoomd.version.mpi_enabled)
device = hoomd.device.CPU()
rank = device.communicator.rank
pid = os.getpid()
print(f'Hello HOOMD-blue rank {rank} from process id {pid}')
```

运行测试命令：

```bash
mpirun -n 4 python3 mpi_test.py
```

如果能输出类似于下面的结果，则表明安装成功

```text
True
True
True
True
Hello HOOMD-blue rank 3 from process id 11567
Hello HOOMD-blue rank 2 from process id 11566
Hello HOOMD-blue rank 0 from process id 11564
Hello HOOMD-blue rank 1 from process id 11565
```

#### hoomd-benchmarks

具体细节可以参考 [HOOMD 在 github 提供的 benchmark 仓库](https://github.com/glotzerlab/hoomd-benchmarks) 的 `README` 文件的说明。

克隆仓库

```bash
git clone --branch trunk --depth 1 https://github.com/glotzerlab/hoomd-benchmarks.git
```

进入目录

```bash
cd hoomd-benchmarks
```

运行测试

```bash
mpirun -n 4 python3 -m hoomd_benchmarks.hpmc_md_pair_lj --device CPU -N 4000 --repeat 10
```

## 其他常用的 package

运行以下命令安装其他常用的包

```bash
micromamba install -c conda-forge freud fresnel gsd matplotlib jupyter signac signac-flow pandas coxeter row rowan
```

需要注意的是 `signac-flow` 已停止更新，可以酌情选择作为其精神后继的 `row` 来安排多任务

`row` 提供了[迁移指南](https://row.readthedocs.io/en/latest/signac-flow.html)。

## CHANGE LOG (v7.2.0)

- 2026/07/21 改进 hoomd-rs 简介与 HOOMD-blue 安装说明; by Harry
- 2026/07/09 调整了部分描述，删除了 miniconda 的部分; by Harry
- 2026/04/11 增加了对于 hoomd-rs 的介绍; by Harry
- 2026/02/27 是否真的需要 build hoomd from source 是一个值得思考的问题; by Harry
- 2026/02/27 增加了网络问题导致 micromamba 不能正确安装的处理方式; by Harry
- 2025/11/09 修改 typos; by Harry
- 2025/08/26 增加了 hoomd-benchmarks 的简单使用方法; by Harry
- 2025/08/26 增加了对于网络问题的处理; by Harry
- 2025/08/13 增加了对于 signac-flow -> row 的描述; by Harry
- 2025/07/04 mpi 部分换用 openmpi; by Harry
- 2025/04/23 改进了部分描述; by Harry
- 2025/03/15 加入了 micromamba 的描述; by Harry
- 2025/01/10 改进了部分描述; by Harry
- 2024/09/21 改进了部分描述; by Harry
- 2024/04/09 更改对于可能出现的问题的解决方案; by Harry
- 2024/04/06 加入 CUDA 安装方式; by 日华
- 2024/04/03 重新加入对于可能出现的问题的解决方案; by Harry
- 2024/03/22 大幅度改动; by Harry
- 2024/03/19 优化部分 bug; by 时六
- 2024/03/10 优化部分 bug; by 日华
- 2024/01/03 优化部分 bug; by 时六
- 2023/10/27 添加 GPU 前置和常用包安装选段; by 时六
