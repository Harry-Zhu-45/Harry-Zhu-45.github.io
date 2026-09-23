---
"title": "Linux常用命令"
"slug": "(Debian系)Linux常用命令"
"pubDate": "2024-07-04T22:38:00+08:00"
"updatedDate": "2026-07-21T09:43:00+08:00"
"categories":
  - "计算机"
"tags": []
---

## 参考内容

- [解决ubuntu terminal 文件夹绿色高亮问题 - 三七鸽 - 博客园 (cnblogs.com)](https://www.cnblogs.com/linux-37ge/p/12944438.html)

## 文件 / 文件夹管理

回上一次所在的目录

```bash
cd -
```

查找路径所在范围内满足字符串匹配的文件和目录

```bash
find 路径 -name 字符串
```

统计当前目录中的文件数

```bash
find . -mindepth 1 -maxdepth 1 -type f | wc -l
```

统计当前目录中的子目录数

```bash
find . -mindepth 1 -maxdepth 1 -type d | wc -l
```

查看某个文件被哪些应用程序读写

```bash
lsof 文件路径
```

将当前目录下最近 30 天访问过的文件移动到上级 back 目录

```bash
find . -type f -atime -30 -exec mv {} ../back \;
```

查找当前目录下，最近 2 到 8 小时内修改过的文件，并用 `more` 逐个打开查看内容。

```bash
find . -mmin +120 -mmin -480 -exec more {} \;
```

### Ubuntu Terminal 文件夹是绿色高亮

一般是因为该目录的权限为 `drwxrwxrwx`，任何人都可以对该目录进行写入操作。系统默认这是一个高风险目录，所以将它显示为醒目的绿色背景。

解决办法很简单：

```bash
sudo chmod o-w 文件夹
```

## 系统管理

查看系统内核

```bash
uname -a
```

查看系统版本

```bash
cat /etc/issue
```

查看 CPU 信息

```bash
lscpu
```

查看内核加载的模块

```bash
lsmod
```

显示当前硬件信息

```bash
lshw
```

查看 PCI 设备

```bash
lspci
```

查看 USB 设备

```bash
lsusb
```

查看网卡 `eth0` 状态

```bash
sudo ethtool eth0
```

```bash
sudo fdisk -l # 查看系统分区信息
sudo fdisk /dev/sdb # 为一块新的 SCSI 硬盘 (/dev/sdb) 进行分区
```

```bash
sudo groupadd 组名 # 创建一个新的组
sudo useradd -m -g 组名 用户名 # 创建用户并指定主用户组
sudo passwd 用户名 # 为用户设置密码
sudo passwd -d 用户名 # 删除用户密码，谨慎使用
sudo passwd -S 用户名 # 查询账号密码状态
sudo usermod -l 新用户名 老用户名 # 为用户改名
sudo userdel -r 用户名 # 删除用户及其主目录
```

```bash
service [servicename] start/stop/restart # 系统服务控制操作
/etc/init.d/[servicename] start/stop/restart #  系统服务控制操作

sudo update-rc.d 服务名 defaults 99 # 添加一个服务
sudo update-rc.d 服务名 remove # 删除一个服务
/etc/init.d/服务名 restart # 临时重启一个服务
/etc/init.d/服务名 stop # 临时关闭一个服务
/etc/init.d/服务名 start # 临时启动一个服务
```

```bash
df -h # 查看硬盘剩余空间
free -m # 查看当前的内存使用情况
```

```bash
ps -A # 查看当前有哪些进程
kill 进程号 # 杀死一个进程
killall 进程名 # 杀死一个进程
kill -9 进程号 # 强制杀死一个进程
```

```bash
sudo reboot # 重启 Linux 系统
sudo halt # 关闭 Linux 系统
```

## 打包 / 解压

```bash
tar -cvf benet.tar /home/benet # 把 /home/benet 目录打包
tar -zcvf benet.tar.gz /mnt # 把目录打包并压缩
tar -zxvf benet.tar.gz # 压缩包的文件解压恢复
tar -jxvf benet.tar.bz2 # 解压缩
```

## 包管理命令

```bash
apt-cache search package # 搜索包
apt-cache show package # 获取包的相关信息，如说明、大小、版本等
apt-cache depends package # 了解使用依赖
apt-cache rdepends package # 查看哪些包依赖该包
```

重新安装包

```bash
sudo apt-get install package --reinstall
```

修复安装

```bash
sudo apt-get -f install
```

```bash
sudo apt-get remove package # 删除包
sudo apt-get remove package --purge # 删除包，包括删除配置文件等
```

```bash
sudo apt-get update # 更新源
sudo apt-get upgrade # 更新已安装的包
sudo apt-get dist-upgrade # 激进更新已安装的包，可能安装新依赖包，也可能删除一些不再需要的旧包
sudo apt-get dselect-upgrade # 使用 dselect 升级
```

```bash
apt-get source package # 下载该包的源代码
sudo apt-get clean && sudo apt-get autoclean # 清理无用的包
sudo apt-get autoremove # 删除系统不再使用的孤立软件
sudo apt-get check # 检查是否有损坏的依赖
sudo apt-get clean # 清理所有软件缓存（即缓存在 /var/cache/apt/archives 目录里的 deb 包）
```

```bash
dpkg -L 软件包名称 # 查看软件包安装内容
dpkg -S filename # 查找已安装文件属于哪个包
apt-file search filename # 在软件源中查找文件属于哪个包
dpkg -l | awk '/^rc/ {print $2}' | xargs -r sudo dpkg --purge # 清除已删除软件包的残余配置文件
```

```bash
sudo auto-apt run ./configure # 编译时缺少 h 文件的自动处理
```

```bash
dpkg --get-selections | grep -v deinstall > ~/somefile # 备份当前系统安装的所有包的列表
sudo dpkg --set-selections < ~/somefile # 恢复软件包的选择状态
sudo apt-get dselect-upgrade # 按选择状态安装或删除软件包
```

## 硬盘

```bash
sudo hdparm -i /dev/hda # 查看 IDE 硬盘信息
sudo hdparm -I /dev/sda # 查看 SATA 硬盘信息

sudo pppoeconf ADSL # 配置 ADSL
sudo pon dsl-provider # ADSL 手工拨号
sudo /etc/ppp/pppoe_on_boot # 激活 ADSL
sudo poff # 断开 ADSL

sudo plog # 查看拨号日志
```

## 网络

根据 IP 查网卡地址

```bash
arping IP地址
```

查看当前 IP 地址

```bash
ifconfig eth0 | awk '/inet/ {split($2,x,":");print x[2]}'
```

```bash
# 查看当前外网的 IP 地址
w3m -no-cookie -dump www.edu.cn | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}'
w3m -no-cookie -dump www.xju.edu.cn | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}'
w3m -no-cookie -dump ip.loveroot.com | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}'
```

查看当前监听 80 端口的程序

```bash
lsof -i :80
```

查看当前网卡的 MAC 地址

```bash
ifconfig eth0 | grep ether | awk '{print $2}'
```

立即让网络支持 NAT

```bash
echo 1 | sudo tee /proc/sys/net/ipv4/ip_forward > /dev/null
sudo iptables -t nat -I POSTROUTING -j MASQUERADE
```

查看路由信息

```bash
netstat -rn
sudo route -n
```

手工增加删除一条路由

```bash
sudo route add -net 192.168.0.0 netmask 255.255.255.0 gw 172.16.0.1
sudo route del -net 192.168.0.0 netmask 255.255.255.0 gw 172.16.0.1
```

```bash
# 修改网卡 MAC 地址的方法
sudo ifconfig eth0 down # 关闭网卡
sudo ifconfig eth0 hw ether 00:AA:BB:CC:DD:EE # 然后改地址
sudo ifconfig eth0 up # 然后启动网卡
```

```bash
# 统计当前 TCP 连接的个数
netstat -na | grep ESTABLISHED | awk '{print $5}' | awk -F: '{print  $1}' | sort | uniq -c | sort -r -n
netstat -na | grep SYN | awk '{print $5}' | awk -F: '{print  $1}' | sort | uniq -c | sort -r -n

# 统计当前 20000 个 IP 包中大于 100 个 IP 包的 IP 地址
sudo tcpdump -tnn -c 20000 -i eth0 | awk -F "." '{print $1"."$2"."$3"."$4}' | sort | uniq -c | sort -nr | awk '$1 > 100'

# 屏蔽 IPv6
echo "blacklist ipv6" | sudo tee /etc/modprobe.d/blacklist-ipv6
```

## 日期和时间

```bash
sudo date -s mm/dd/yy # 设置日期
sudo date -s HH:MM # 设置时间
sudo hwclock --systohc # 将系统时间写入硬件时钟
sudo hwclock --hctosys # 从硬件时钟读取系统时间
sudo ntpdate time.nist.gov # 从服务器上同步时间
sudo ntpdate time.windows.com # 从服务器上同步时间
```

## 数据库

### 从 MySQL 中导出和导入数据

```bash
mysqldump 数据库名 > 文件名 # 导出数据库
mysqladmin create 数据库名 # 建立数据库
mysql 数据库名 < 文件名 # 导入数据库
```

### 忘了 MySQL 的 root 口令怎么办

```bash
sudo /etc/init.d/mysql stop
sudo mysqld_safe --skip-grant-tables
sudo mysqladmin -u user password 新密码
sudo mysqladmin flush-privileges
```
